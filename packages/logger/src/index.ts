export const log = (...args: unknown[]): void => {
  // eslint-disable-next-line no-console -- logger
  console.log('[LOGGER]', ...args);
};

export const logger = {
  info: (msg: string, ...args: unknown[]): void => {
    // eslint-disable-next-line no-console -- logger
    console.log(`[INFO] ${msg}`, ...args);
  },
  warn: (msg: string, ...args: unknown[]): void => {
    // eslint-disable-next-line no-console -- logger
    console.warn(`[WARN] ${msg}`, ...args);
  },
  error: (msg: string, ...args: unknown[]): void => {
    // eslint-disable-next-line no-console -- logger
    console.error(`[ERROR] ${msg}`, ...args);
  },
  debug: (msg: string, ...args: unknown[]): void => {
    // eslint-disable-next-line no-console -- logger
    console.debug(`[DEBUG] ${msg}`, ...args);
  },
};
