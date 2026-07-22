#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
    echo "install.sh must run as root" >&2
    exit 1
fi

deploy_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
install -d -m 0755 /usr/local/libexec
install -m 0755 "$deploy_dir/deploy_agent.py" /usr/local/libexec/manga-deploy
install -m 0600 "$deploy_dir/manga-deploy.conf" /etc/manga-deploy.conf
install -m 0644 "$deploy_dir/manga-deploy.service" /etc/systemd/system/manga-deploy.service
systemctl daemon-reload
systemctl enable --now manga-deploy.service
