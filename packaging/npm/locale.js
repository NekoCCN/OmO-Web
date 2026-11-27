const system = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG
  || Intl.DateTimeFormat().resolvedOptions().locale;
export const cliLocale = /^zh(?:[-_.@]|$)/iu.test(system) ? "zh-CN" : "en";

/** @param {string} zh @param {string} en */
export const cliTr = (zh, en) => cliLocale === "zh-CN" ? zh : en;
