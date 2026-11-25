// Stamps the manual's first line ("REV RADAR <version> - ...") with the package version. Throws if the line
// is not there, so a stale stamp cannot pass silently.
export function stampReadme(text, version) {
  if (!/^REV RADAR \S+/.test(text)) throw new Error('pack/README.txt: line 1 has no "REV RADAR <version>"');
  return text.replace(/^REV RADAR \S+/, `REV RADAR ${version}`);
}
