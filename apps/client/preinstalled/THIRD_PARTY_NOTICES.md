# Rufajx-DSH bundled Office, PDF, OCR and sidebar components

Pinned source revisions, Python wheel versions, download URLs and SHA-256 digests
are recorded in `PREINSTALLED-LOCK.json` in the runtime (`preinstalled.lock.json`
in the company source project). No employee startup downloads are required.

- `@deepseek-ai/dsh-skill-office` 0.2.1-rc.2: DeepSeek Harness, MIT; uses the
  company's existing pinned Harness source and its included upstream license.
- `@deepseek-ai/libreoffice-kit` 0.1.5 and Windows engine: MPL-2.0; original
  package NOTICE, licenses and platform assets are retained under node_modules.
- `dsh-read-pdf`: https://github.com/xiaoxuPekingUniversity/dsh-read-pdf,
  commit `9e9186b1a6aedf5e97d3c4044db7f33caf366b9d`, MIT. The unchanged
  `pdf_tools.py` CLI and license ship under company-tools/dsh-read-pdf. A company
  host adapter supplies current Harness APIs, per-session paths and cancellation.
  The author's personal-directory MCP and standalone drop server are not started.
- `dsh-file-upload-ocr-plugin` 2.0.0:
  https://github.com/BYYY-eng/deepseek-harness-file-upload-ocr-plugin,
  commit `c4b407a200fd82f1115ef0a54345316ff76cf1c9`, MIT. Original source,
  licenses and third-party notices ship with the package. The company patch adds
  `windowsHide: true` to its Python child process, catches malformed worker JSON,
  and uses the current close icon. Two legacy attachment component exports are
  restored in the pinned materialized Harness client bundle; the original
  component implementations and upstream source checkout remain unchanged. The
  adapted package declares exact 0.2.1-rc.2 Harness peer dependencies; its original
  manifest is preserved as UPSTREAM-package.json. Other plugins' compatibility
  checks are not weakened.
- CPython 3.12.10 Windows embeddable distribution: Python Software Foundation
  License; `company-python/LICENSE.txt` retains the original license.
- `dsh-better-sidebar` 0.28.0:
  https://github.com/omdsh-dev/DSH-better-sidebar, MIT. The exact npm distribution
  and its dependency graph are pinned by `preinstalled/sidebar/package-lock.json`
  in the company source and `SIDEBAR-PACKAGE-LOCK.json` in the runtime. The
  original package LICENSE and all dependency LICENSE/NOTICE files are retained
  in its package and nested node_modules. Build preparation is implemented in
  `scripts/sidebar-runtime.mjs`; company compatibility changes are replayable
  through `scripts/sidebar-compat.mjs`. This notice records provenance and does
  not claim completed GUI acceptance.
- PyMuPDF (and its MuPDF dependency) in the PDF reader: AGPL-3.0/commercial dual
  licensing. The pinned PyPI distribution, upstream license and source/project
  references are retained in the Python package metadata. This is distinct from
  File Upload & OCR's pypdfium2/PDFium implementation.
- `dsh-video-preview` 0.1.4:
  https://github.com/zemul/dsh-video-preview, MIT; and
  `@huanlin/dsh-plugin-better-sidebar-plugin-audio` 0.1.0:
  https://github.com/huanlinoto/dsh-plugin-better-sidebar-plugin-audio, MIT.
  Exact npm distributions are pinned by `preinstalled/media-preview/package-lock.json`
  in the company source and `MEDIA-PREVIEW-PACKAGE-LOCK.json` in the runtime.
  Original package LICENSE files are retained. Preparation and replayable host
  compatibility adaptations are maintained by `scripts/media-preview-runtime.mjs`
  and `scripts/media-preview-compat.mjs`. No additional host, React or Cordis copy
  is installed through their optional peers. This records provenance, not
  completed media playback acceptance.
- Additional Python libraries (including RapidOCR's bundled ONNX models,
  ONNX Runtime, OpenCV, NumPy, Pillow, pandas, python-docx, python-pptx, openpyxl,
  pypdfium2 and their dependencies) retain their original LICENSE/NOTICE and
  `.dist-info` metadata under company-python/Lib/site-packages.

Company integration code is held in apps/client/preinstalled and the replayable
preparation scripts. Runtime packages do not contain a DeepSeek API key; extracted
text enters the normal company-authenticated conversation path when submitted.
