/**
 * lib-plan-flows.js — page-cited state-rail-plan tonnage stats for the
 * commodity page generator (Phase A3 of the rail data foundation).
 *
 * Data: scripts/plan-flows.json, generated from the 7 Southeast state rail
 * plan extracts by bots/assistant/businesses/steel-wheel/scripts/
 * build-plan-flows.py. Each row is ONE citable figure with its plan page.
 *
 * SOURCE-MIXING RULE: rows are tagged source_type (waybill | faf | transearch
 * | plan). FAF and STB Waybill measure different things and must NEVER be
 * combined or compared in a single displayed stat. This module never
 * aggregates — every stat line it returns renders exactly one row with that
 * row's own citation — and the per-state picker means a page never shows two
 * differently-sourced figures for the same state.
 *
 * BRAND RULE: intermodal / drayage / container never appear. Banned-label
 * rows are dropped upstream; a belt-and-suspenders guard here drops any
 * rendered line that would trip the generator's self-check.
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";

const DATA = JSON.parse(
  readFileSync(join(dirname(new URL(import.meta.url).pathname), "plan-flows.json"), "utf-8")
);

const BANNED = /intermodal|drayage|container/i;

/* Prefer, within a state: all-direction/total figures over single-direction
 * ones, then Waybill over FAF/other, then the larger tonnage. */
function score(r) {
  return (r.is_total ? 2 : 0) + (r.source_type === "waybill" ? 1 : 0);
}

function tonsText(r) {
  if (r.tons_text) return r.tons_text;                       // narrative figures ("nearly 50 million tons")
  if (r.tons >= 1e6) {
    const m = (r.tons / 1e6).toFixed(1).replace(/\.0$/, "");
    return `${m} million tons`;
  }
  return `${r.tons.toLocaleString("en-US")} tons`;
}

/**
 * Up to `limit` stat lines for one site commodity slug — at most one line per
 * state, sorted by tonnage. Each entry: { text, state, source_type, year }.
 */
export function statsForCommodity(slug, limit = 5) {
  const byState = new Map();
  for (const r of DATA.flows) {
    const slugs = r.commodity_slug == null ? []
      : Array.isArray(r.commodity_slug) ? r.commodity_slug : [r.commodity_slug];
    if (!slugs.includes(slug)) continue;
    if (!(r.tons > 0)) continue;
    const prev = byState.get(r.state);
    if (!prev || score(r) > score(prev) ||
        (score(r) === score(prev) && r.tons > prev.tons)) {
      byState.set(r.state, r);
    }
  }
  return [...byState.values()]
    .sort((a, b) => b.tons - a.tons)
    .slice(0, limit)
    .map((r) => ({
      state: r.state_name,
      source_type: r.source_type,
      year: r.year,
      text: `${r.state_name}: ${tonsText(r)} of ${r.commodity_display} ` +
            `${r.dir_phrase} in ${r.year} (${r.source}).`,
    }))
    .filter((s) => !BANNED.test(s.text));
}
