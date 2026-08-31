// @module lib/readerWatch — reliability helpers for Reader transcript watches.
//
// Codex keeps a rollout file open on Windows and appends to it while its mtime
// can remain frozen for the whole turn/session. chokidar 3's polling backend
// notices the size change in fs.watchFile, but its public `change` path then
// suppresses the event when mtime is unchanged and atime is newer than mtime.
// The lower-level `raw` event is emitted before that suppression. Treat only a
// real raw size delta as a fallback change signal; the normal add/change path
// remains authoritative everywhere else.

function isRawSizeChange(details) {
  if (!details || !details.curr || !details.prev) return false;
  const current = details.curr.size;
  const previous = details.prev.size;
  return Number.isFinite(current) && Number.isFinite(previous) && current !== previous;
}

function attachRawSizeChangeFallback(watcher, onSizeChange) {
  if (!watcher || typeof watcher.on !== 'function' || typeof onSizeChange !== 'function') return;
  watcher.on('raw', (_event, _path, details) => {
    if (isRawSizeChange(details)) onSizeChange();
  });
}

module.exports = { isRawSizeChange, attachRawSizeChangeFallback };
