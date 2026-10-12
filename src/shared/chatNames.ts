/**
 * A chat's short name: a trailing UPPERCASE word in its name is taken as
 * the name of the agent working in it — "Magic Patch - DANNY" is DANNY,
 * "convert more packs MERVYN" is MERVYN — and a chat with none goes by
 * its full name. (A name can be three letters — AMY, MOE — so a chat
 * that ends in an acronym, "Fix the API", reads as API.)
 */
export function chatShortName(name: string): string {
  const m = /(?:^|[\s\-–—_:|/(])([A-Z][A-Z0-9_]+)\)?\s*$/.exec(name.trim());
  return m ? m[1] : name.trim();
}
