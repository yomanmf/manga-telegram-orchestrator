#!/usr/bin/env python3
from __future__ import annotations

import fcntl
import ipaddress
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

DIGEST_RE = re.compile(r"sha256:[0-9a-f]{64}")
REVISION_RE = re.compile(r"[0-9a-f]{40}")
DEPLOY_ID_RE = re.compile(r"[0-9]+/[0-9]+")
TOKEN_URL = (
    "http://169.254.169.254/computeMetadata/v1/instance/"
    "service-accounts/default/token"
)


class DeployError(RuntimeError):
    def __init__(self, message: str, code: str = "DEPLOYMENT_ERROR") -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True, slots=True)
class Config:
    registry_host: str
    registry_id: str
    repository_prefix: str
    compose_path: Path
    state_dir: Path
    project_name: str = "deploy"
    candidate_tag: str = "candidate"
    telegram_api_ip: str = ""
    stable_seconds: int = 8
    poll_seconds: int = 8

    @property
    def services(self) -> tuple[str, ...]:
        return ("manga-bot-worker", "manga-pdf-processor", "kindle-uploader")

    def repository(self, service: str) -> str:
        return f"{self.registry_host}/{self.registry_id}/{self.repository_prefix}{service}"

    @classmethod
    def load(cls, path: Path) -> Config:
        values: dict[str, str] = {}
        for number, raw in enumerate(path.read_text().splitlines(), start=1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                raise DeployError(f"Invalid config line {number}", "INVALID_CONFIG")
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip()
        required = ("REGISTRY_HOST", "REGISTRY_ID", "COMPOSE_PATH", "STATE_DIR")
        missing = [key for key in required if not values.get(key)]
        if missing:
            raise DeployError(f"Missing config: {', '.join(missing)}", "INVALID_CONFIG")
        compose_path = Path(values["COMPOSE_PATH"])
        state_dir = Path(values["STATE_DIR"])
        if not compose_path.is_absolute() or not state_dir.is_absolute():
            raise DeployError("Configured paths must be absolute", "INVALID_CONFIG")
        telegram_api_ip = values.get("TELEGRAM_API_IP", "")
        if telegram_api_ip:
            try:
                address = ipaddress.ip_address(telegram_api_ip)
            except ValueError as exc:
                raise DeployError("TELEGRAM_API_IP must be an IPv4 address", "INVALID_CONFIG") from exc
            if address.version != 4:
                raise DeployError("TELEGRAM_API_IP must be an IPv4 address", "INVALID_CONFIG")
        return cls(
            registry_host=values["REGISTRY_HOST"],
            registry_id=values["REGISTRY_ID"],
            repository_prefix=values.get("REPOSITORY_PREFIX", "manga-"),
            compose_path=compose_path,
            state_dir=state_dir,
            project_name=values.get("PROJECT_NAME", "deploy"),
            candidate_tag=values.get("CANDIDATE_TAG", "candidate"),
            telegram_api_ip=telegram_api_ip,
            stable_seconds=int(values.get("STABLE_SECONDS", "8")),
            poll_seconds=int(values.get("POLL_SECONDS", "8")),
        )


@dataclass(frozen=True, slots=True)
class Candidate:
    service: str
    image: str
    digest: str
    revision: str
    deploy_id: str


def emit(
    config: Config,
    candidate: Candidate,
    phase: str,
    status: str,
    *,
    terminal: bool = False,
    error_code: str | None = None,
    duration: float | None = None,
    reused: bool = False,
) -> None:
    payload: dict[str, Any] = {
        "timestamp": datetime.now(UTC).isoformat(timespec="seconds"),
        "project": f"manga-telegram-orchestrator/{candidate.service}",
        "service": candidate.service,
        "deploy_id": candidate.deploy_id,
        "revision": candidate.revision,
        "phase": phase,
        "status": status,
        "terminal": terminal,
        "digest": candidate.digest,
    }
    if error_code:
        payload["error_code"] = error_code
    if duration is not None:
        payload["duration_seconds"] = round(duration, 1)
    if reused:
        payload["reused"] = True
    print("DEPLOY_EVENT " + json.dumps(payload, separators=(",", ":")), flush=True)


def command(
    args: list[str],
    *,
    input_text: str | None = None,
    check: bool = True,
    timeout: int | None = None,
    code: str = "COMMAND_FAILED",
) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(
            args,
            input=input_text,
            text=True,
            capture_output=True,
            check=False,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        raise DeployError(f"{args[0]} timed out", f"{code}_TIMEOUT") from exc
    if check and result.returncode:
        raise DeployError(f"{args[0]} failed", code)
    return result


def iam_token() -> str:
    request = urllib.request.Request(TOKEN_URL, headers={"Metadata-Flavor": "Google"})
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            token = json.load(response).get("access_token")
    except (OSError, ValueError) as exc:
        raise DeployError("Could not get VM token", "VM_TOKEN_UNAVAILABLE") from exc
    if not isinstance(token, str) or not token:
        raise DeployError("VM token is empty", "VM_TOKEN_UNAVAILABLE")
    return token


class Docker:
    def __init__(self, config: Config, docker_config: Path, runtime: Path) -> None:
        self.config = config
        self.docker_config = docker_config
        self.runtime = runtime

    def login(self) -> None:
        command(
            [
                "docker",
                "--config",
                str(self.docker_config),
                "login",
                "--username",
                "iam",
                "--password-stdin",
                self.config.registry_host,
            ],
            input_text=iam_token(),
            code="REGISTRY_LOGIN_FAILED",
        )

    def _pull(self, image: str) -> None:
        command(
            ["docker", "--config", str(self.docker_config), "pull", image],
            code="IMAGE_PULL_FAILED",
        )

    @staticmethod
    def _image_info(image: str) -> dict[str, Any]:
        result = command(["docker", "image", "inspect", image])
        try:
            return json.loads(result.stdout)[0]
        except (ValueError, IndexError, TypeError) as exc:
            raise DeployError("Invalid image metadata", "INVALID_IMAGE") from exc

    @staticmethod
    def _digest(info: dict[str, Any], repository: str) -> str:
        prefix = f"{repository}@"
        for value in info.get("RepoDigests") or []:
            if value.startswith(prefix) and DIGEST_RE.fullmatch(value[len(prefix) :]):
                return value[len(prefix) :]
        raise DeployError("Image has no digest", "INVALID_IMAGE")

    def candidate(self, service: str) -> Candidate:
        repository = self.config.repository(service)
        mutable = f"{repository}:{self.config.candidate_tag}"
        self._pull(mutable)
        info = self._image_info(mutable)
        digest = self._digest(info, repository)
        labels = info.get("Config", {}).get("Labels") or {}
        revision = labels.get("org.opencontainers.image.revision", "")
        deploy_id = labels.get("org.opencontainers.image.deploy-id", "")
        if not REVISION_RE.fullmatch(revision) or not DEPLOY_ID_RE.fullmatch(deploy_id):
            raise DeployError("Image labels are invalid", "INVALID_IMAGE_LABELS")
        immutable = f"{repository}:{revision}"
        self._pull(immutable)
        if self._digest(self._image_info(immutable), repository) != digest:
            raise DeployError("Mutable and immutable tags differ", "DIGEST_MISMATCH")
        return Candidate(service, f"{repository}@{digest}", digest, revision, deploy_id)

    def container_id(self, service: str) -> str | None:
        result = command(
            [
                "docker",
                "compose",
                "--project-name",
                self.config.project_name,
                "--file",
                str(self.config.compose_path),
                "ps",
                "--quiet",
                service,
            ],
            check=False,
        )
        value = result.stdout.strip()
        return value or None

    @staticmethod
    def inspect_container(container_id: str) -> dict[str, Any]:
        result = command(["docker", "inspect", container_id])
        try:
            return json.loads(result.stdout)[0]
        except (ValueError, IndexError, TypeError) as exc:
            raise DeployError("Invalid container metadata", "INVALID_CONTAINER") from exc

    def current_image(self, service: str) -> str | None:
        container_id = self.container_id(service)
        if not container_id:
            return None
        return self.inspect_container(container_id).get("Config", {}).get("Image")

    def smoke(self, candidate: Candidate) -> None:
        checks = {
            "manga-bot-worker": ["node", "--check", "src/index.mjs"],
            "manga-pdf-processor": [
                "bun",
                "-e",
                'import sharp from "sharp"; await sharp({create:{width:1,height:1,channels:4,background:"#fff"}}).png().toBuffer()',
            ],
            "kindle-uploader": ["node", "--check", "server.mjs"],
        }
        command(
            ["docker", "run", "--rm", "--entrypoint", checks[candidate.service][0], candidate.image]
            + checks[candidate.service][1:],
            timeout=60,
            code="SMOKE_FAILED",
        )

    def rollout(self, service: str, image: str) -> None:
        override = self.runtime / f"{service}.yaml"
        lines = ["services:", f"  {service}:", f"    image: {image}"]
        if service == "manga-bot-worker" and self.config.telegram_api_ip:
            lines.extend([
                "    extra_hosts:",
                f'      - "api.telegram.org:{self.config.telegram_api_ip}"',
            ])
        override.write_text("\n".join(lines) + "\n")
        command(
            [
                "docker",
                "compose",
                "--project-name",
                self.config.project_name,
                "--project-directory",
                str(self.config.compose_path.parent),
                "--file",
                str(self.config.compose_path),
                "--file",
                str(override),
                "up",
                "--detach",
                "--no-build",
                "--no-deps",
                service,
            ],
            timeout=120,
            code="ROLLOUT_FAILED",
        )

    def verify(self, service: str) -> None:
        time.sleep(self.config.stable_seconds)
        container_id = self.container_id(service)
        if not container_id:
            raise DeployError("Container is missing", "READINESS_FAILED")
        info = self.inspect_container(container_id)
        if not info.get("State", {}).get("Running") or info.get("RestartCount", 0):
            raise DeployError("Container is not stable", "READINESS_FAILED")
        networks = info.get("NetworkSettings", {}).get("Networks") or {}
        address = next(
            (value.get("IPAddress") for value in networks.values() if value.get("IPAddress")),
            "",
        )
        if not address:
            raise DeployError("Container has no network address", "READINESS_FAILED")
        try:
            urllib.request.urlopen(f"http://{address}:3000/", timeout=5).close()
        except urllib.error.HTTPError as exc:
            if exc.code >= 500:
                raise DeployError("Service returned 5xx", "READINESS_FAILED") from exc
        except OSError as exc:
            raise DeployError("Service is unreachable", "READINESS_FAILED") from exc


def read_json(path: Path) -> dict[str, str]:
    try:
        value = json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def write_json(path: Path, value: dict[str, str]) -> None:
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, separators=(",", ":")) + "\n")
    temporary.chmod(0o600)
    os.replace(temporary, path)


def deploy(config: Config, docker: Docker, candidate: Candidate) -> bool:
    state = config.state_dir / f"{candidate.service}.digest"
    failed_path = config.state_dir / f"{candidate.service}.failed"
    failed = read_json(failed_path)
    if failed.get("deploy_id") == candidate.deploy_id:
        emit(
            config,
            candidate,
            "complete",
            "failed",
            terminal=True,
            error_code=failed.get("error_code", "QUARANTINED_FAILURE"),
            reused=True,
        )
        return False
    current_image = docker.current_image(candidate.service)
    try:
        current_digest = state.read_text().strip()
    except OSError:
        current_digest = ""
    if current_digest == candidate.digest and current_image == candidate.image:
        emit(config, candidate, "complete", "success", terminal=True, reused=True)
        return False

    started = time.monotonic()
    emit(config, candidate, "deploy", "started")
    try:
        docker.smoke(candidate)
        emit(config, candidate, "smoke", "success")
        docker.rollout(candidate.service, candidate.image)
        try:
            docker.verify(candidate.service)
        except DeployError:
            if current_image:
                docker.rollout(candidate.service, current_image)
                docker.verify(candidate.service)
                emit(config, candidate, "rollback", "success")
            else:
                emit(config, candidate, "rollback", "none")
            raise
        state.write_text(candidate.digest + "\n")
        failed_path.unlink(missing_ok=True)
        emit(
            config,
            candidate,
            "complete",
            "success",
            terminal=True,
            duration=time.monotonic() - started,
        )
        return True
    except DeployError as exc:
        write_json(
            failed_path,
            {
                "deploy_id": candidate.deploy_id,
                "revision": candidate.revision,
                "error_code": exc.code,
            },
        )
        emit(
            config,
            candidate,
            "complete",
            "failed",
            terminal=True,
            error_code=exc.code,
            duration=time.monotonic() - started,
        )
        raise


def watch(config_path: Path) -> None:
    config = Config.load(config_path)
    if not config.compose_path.is_file():
        raise SystemExit("Compose file is missing")
    config.state_dir.mkdir(parents=True, exist_ok=True)
    with Path("/run/manga-deploy.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        runtime = Path(tempfile.mkdtemp(prefix="manga-deploy-", dir="/run"))
        try:
            docker_config = runtime / "docker"
            docker_config.mkdir(mode=0o700)
            docker = Docker(config, docker_config, runtime)
            authenticated = False
            last_ids = {service: "" for service in config.services}
            while True:
                for service in config.services:
                    try:
                        if not authenticated:
                            docker.login()
                            authenticated = True
                        candidate = docker.candidate(service)
                        if candidate.deploy_id != last_ids[service]:
                            last_ids[service] = candidate.deploy_id
                            try:
                                deploy(config, docker, candidate)
                            except DeployError:
                                pass
                    except DeployError:
                        authenticated = False
                time.sleep(config.poll_seconds)
        finally:
            shutil.rmtree(runtime, ignore_errors=True)


def main() -> None:
    if os.geteuid() != 0:
        raise SystemExit("deploy-agent must run as root")
    watch(Path("/etc/manga-deploy.conf"))


if __name__ == "__main__":
    main()
