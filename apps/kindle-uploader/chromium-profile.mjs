export function isChromiumProfileLockError(error) {
  return /profile appears to be in use|process_singleton_posix/i
    .test(error instanceof Error ? error.message : String(error));
}

export const CHROMIUM_SINGLETON_FILES = [
  "SingletonLock",
  "SingletonSocket",
  "SingletonCookie"
];
