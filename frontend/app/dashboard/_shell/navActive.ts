// Which sidebar item is highlighted. Pure, so it can be tested without a browser.
//
// An item can be a plain page ("/dashboard/reports") or a shortcut into a tab of a page ("/dashboard/reports?tab=productivity"). Several items can open the
// same page (Admin's "Reports & Analytics" and "Productivity"; "User Management" and "System Settings"). Rule:
//   * a shortcut item is highlighted when the page matches AND the address carries its tab;
//   * the plain item is highlighted when the page matches AND no shortcut for that page matches the address (so exactly one item is lit).
export type SearchLike = { get(name: string): string | null };

function queryMatches(query: string, search: SearchLike): boolean {
  const want = new URLSearchParams(query);
  for (const [k, v] of want) if (search.get(k) !== v) return false;
  return true;
}

// An item that opens a section with several addresses stays lit on all of them (Organization Management: /company, /hierarchy, /projects).
const SECTIONS: Record<string, string> = { "/dashboard/organization/company": "/dashboard/organization/" };

export function isNavActive(href: string, allHrefs: string[], pathname: string, search: SearchLike): boolean {
  const [path, query] = href.split("?");
  if (SECTIONS[path] && pathname.startsWith(SECTIONS[path])) return true;
  if (pathname !== path) return false;
  if (query) return queryMatches(query, search);
  return !allHrefs.some((h) => {
    const [p, q] = h.split("?");
    return !!q && p === path && queryMatches(q, search);
  });
}
