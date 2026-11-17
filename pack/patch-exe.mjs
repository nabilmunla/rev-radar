// Icon and version details of the app's .exe: node patch-exe.cjs <exe> <ico> <version>
import * as ResEdit from 'resedit';
import * as PELibrary from 'pe-library';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
const [exePath, icoPath, version] = process.argv.slice(2);
const exe = PELibrary.NtExecutable.from(readFileSync(exePath), { ignoreCert: true });
const res = PELibrary.NtExecutableResource.from(exe);
const ico = ResEdit.Data.IconFile.from(readFileSync(icoPath));
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, ico.icons.map((i) => i.data));
const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0] || ResEdit.Resource.VersionInfo.createEmpty();
const [a, b, c] = version.split('.').map(Number);
vi.setFileVersion(a, b, c, 0, 1033);
vi.setProductVersion(a, b, c, 0, 1033);
vi.setStringValues({ lang: 1033, codepage: 1200 }, {
  FileDescription: 'Rev Radar', ProductName: 'Rev Radar', InternalName: 'Rev Radar', OriginalFilename: 'Rev Radar.exe',
  CompanyName: '', LegalCopyright: '', FileVersion: version, ProductVersion: version,
});
vi.outputToResourceEntries(res.entries);
res.outputResource(exe);
writeFileSync(exePath + '.new', Buffer.from(exe.generate()));
renameSync(exePath + '.new', exePath);
console.log('patched', exePath);
