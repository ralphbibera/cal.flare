const i18n = require("../../i18n.json");

const config = {
  i18n: {
    defaultLocale: i18n.locale.source,
    locales: i18n.locale.targets.concat([i18n.locale.source]),
  },
  fallbackLng: {
    default: ["en"],
    zh: ["zh-CN"],
  },
};

module.exports = config;
