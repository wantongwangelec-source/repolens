import type { MessageParams, Translation } from "./index";

/** The number may already include a thousands separator, determine singular or plural based on the value after removing the commas. */
export function count(params: MessageParams, key = "count"): string {
  return String(params[key] ?? "");
}

export function plural(params: MessageParams, one: string, many: string, key = "count"): string {
  return Number(count(params, key).replace(/,/g, "")) === 1 ? one : many;
}

/** `{count} files` entries like these differ only by the singular or plural form of the noun */
export function counted(one: string, many: string, key = "count"): Translation {
  return (params) => `${count(params, key)} ${plural(params, one, many, key)}`;
}
