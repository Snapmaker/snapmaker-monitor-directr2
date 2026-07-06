/**
 * 日志工具（输出到 Workers Logs，wrangler tail / Dashboard 可见）
 *
 * LOG_LEVEL 控制输出级别：debug < info < warn < error，默认 info。
 */
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

function getLevel(env) {
  return LEVELS[env?.LOG_LEVEL] ?? LEVELS.info;
}

function shouldLog(env, level) {
  return level >= getLevel(env);
}

function formatArgs(...args) {
  // 第一个参数如果是对象则 JSON 化
  if (args.length > 0 && typeof args[0] === 'object' && args[0] !== null) {
    const meta = JSON.stringify(args[0]);
    const msg = args.slice(1).join(' ');
    return msg ? `${meta} ${msg}` : meta;
  }
  return args.join(' ');
}

export const logger = {
  debug: (...args) => {
    if (shouldLog(null, LEVELS.debug)) console.debug('[debug]', formatArgs(...args));
  },
  info: (...args) => {
    if (shouldLog(null, LEVELS.info)) console.log('[info]', formatArgs(...args));
  },
  warn: (...args) => {
    if (shouldLog(null, LEVELS.warn)) console.warn('[warn]', formatArgs(...args));
  },
  error: (...args) => {
    if (shouldLog(null, LEVELS.error)) console.error('[error]', formatArgs(...args));
  },
};

/**
 * 带 env 的工厂函数（日志级别由 env.LOG_LEVEL 控制）
 */
export function createLogger(env) {
  const min = getLevel(env);
  return {
    debug: (...args) => {
      if (LEVELS.debug >= min) console.debug('[debug]', formatArgs(...args));
    },
    info: (...args) => {
      if (LEVELS.info >= min) console.log('[info]', formatArgs(...args));
    },
    warn: (...args) => {
      if (LEVELS.warn >= min) console.warn('[warn]', formatArgs(...args));
    },
    error: (...args) => {
      if (LEVELS.error >= min) console.error('[error]', formatArgs(...args));
    },
  };
}
