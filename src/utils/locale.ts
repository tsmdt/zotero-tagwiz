import { config } from "../../package.json";
import { FluentMessageId } from "../../typings/i10n";

export { initLocale, getString, getLocaleID };

function initLocale() {
  const l10n = new (
    typeof Localization === "undefined"
      ? ztoolkit.getGlobal("Localization")
      : Localization
  )([`${config.addonRef}-addon.ftl`], true);
  addon.data.locale = {
    current: l10n,
  };
}

/**
 * The string of a message in addon.ftl, with `args` filled in. Falls back to
 * the prefixed ID if the message is missing.
 */
function getString(
  id: FluentMessageId,
  options: { args?: L10nArgs } = {},
): string {
  const prefixed = getLocaleID(id);
  const pattern = addon.data.locale?.current.formatMessagesSync([
    { id: prefixed, args: options.args },
  ])[0] as { value: string | null } | undefined;
  return pattern?.value || prefixed;
}

function getLocaleID(id: FluentMessageId) {
  return `${config.addonRef}-${id}`;
}
