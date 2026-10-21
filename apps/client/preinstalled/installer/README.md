# Rufa installer components

This component preserves the 7-Zip 19.00 decoder used by electron-builder 26.15.3.
The bundled official Nsis7z source matches the original x86 Unicode plugin.
Rufa changes only its entry-point error reporting and progress handling:

- Catch decoder exceptions and return a nonzero result; propagate archive/file errors.
- Push one integer result and set NSIS's error flag on failure.
- Use full 64-bit progress counts; reject unknown/zero totals before division.
- Limit UI callbacks to 10 per second (plus final progress), without changing
  extraction or the decoder source.
- Guard progress bounds. No decoder, compression format or application files change.

Official source archives, their license texts and the replayable patch/build script
are distributed with the installer in `resources/installer-source`.
See `installer.lock.json` for source URLs, checksums and the accepted DLL hash.
7-Zip's LGPL, BSD and unRAR terms are included in License.txt, copying.txt and
unRarLicense.txt. The unRAR restriction is part of the original source package;
this plugin is used only for 7z extraction.

To rebuild from this repository on the build machine, run
`scripts/build-nsis7z.ps1 -SevenZip <7za.exe> -Node <node.exe>` from apps/client.
It expands both bundled source archives into a new temporary directory, applies
`patch-nsis7z.mjs` only after checking the original file hash and invokes MSVC
with a static C runtime. It never modifies the original archives or vendor.
MSVC/SDK overrides are script parameters. Review and update the DLL hash after
an intentional rebuild; timestamps/toolchain differences can change its bytes.

For the source copy installed outside the repository, create a directory with
`scripts/` and `preinstalled/installer/`. Put the two `.mjs`/`.ps1` build files in
`scripts/`, and these source archives, license files and lock in
`preinstalled/installer/`, then run the same command. Rebuilding requires the
build tools only; employees need no additional runtime or network download.

`RufaUpgradeTemp.dll` runs the existing uninstaller with a private, unique TEMP/TMP
directory on the installation volume. It checks actual relative path lengths and
prefers the shortest writable canonical ancestor, using a compact encoding of
all 128 GUID bits. This keeps the native uninstaller's recovery paths within its
legacy Windows path limits. Only the child process environment changes;
the parent environment remains unchanged. The original `un.atomicRMDir` and
`un.restoreFiles`, retry and launch fallback paths remain intact. The helper waits
while processing window messages and displays an indeterminate progress bar.
If no protected same-volume directory fits the path budget, or the tree cannot
be safely measured, the caller labels compatibility mode and uses the unchanged
native ExecWait/TEMP behavior. Invalid installation roots and failed verification
of a newly created private directory stop before launch. Successful child exit
in same-volume mode permits cleanup of only that
owned directory without following directory links; failed child exit retains any
remaining recovery files. This does not recreate files already removed by the old
uninstaller itself.

The helper uses the current user's privileges, Windows APIs and a static C runtime.
Its complete source and build script are also installed, bringing the source and
notice bundle to eleven files. To rebuild it from this repository, run
`scripts/build-upgrade-temp.ps1` from apps/client. For an installed source copy,
put `installer-upgrade-temp.cpp` and `build-upgrade-temp.ps1` in `scripts/` beside
the extraction build scripts, then run the same command. Review and update its
DLL hash in `installer.lock.json` after an intentional rebuild.
