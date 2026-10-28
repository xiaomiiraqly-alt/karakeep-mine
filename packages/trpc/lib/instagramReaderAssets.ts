/**
 * Replace local Instagram media placeholders on authorized Reader requests.
 *
 * The stored HTML contains only stable asset IDs; signed URLs are created on
 * demand so they never expire in the database or leak across bookmarks.
 */
export function hydrateInstagramReaderAssets(
  html: string | null,
  allowedIds: ReadonlySet<string>,
  getSignedUrl: (id: string) => string,
): string | null {
  if (html === null) return null;
  return html.replace(
    /src="karakeep-asset:([a-zA-Z0-9-]+)"/g,
    (_match, id: string) =>
      allowedIds.has(id)
        ? 'src="' + getSignedUrl(id).replace(/&/g, "&amp;") + '"'
        : "",
  );
}
