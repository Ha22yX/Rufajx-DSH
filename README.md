<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img src="docs/assets/readme-cover.svg" alt="Rufajx-DSH — a little help for a lot of real work. Built for my dad’s company." width="100%">
</p>

<p align="center">
  <strong>An AI workspace I’m building for my dad’s company, Rufa Machinery Co., Ltd.</strong><br>
  For the everyday office work and design tasks that take up a little too much time.
</p>

<p align="center">
  <a href="#why-im-building-this">The story</a> ·
  <a href="#what-it-can-help-with">Features</a> ·
  <a href="#a-look-inside">Screenshots</a> ·
  <a href="#try-the-source">Get started</a> ·
  <a href="#built-with-help-from">Credits</a>
</p>

<p align="center">
  <a href="https://github.com/Ha22yX/Rufajx-DSH/actions/workflows/source-checks.yml"><img src="https://github.com/Ha22yX/Rufajx-DSH/actions/workflows/source-checks.yml/badge.svg" alt="Source checks"></a>
  <br><sub>Windows x64 · Based on DeepSeek Harness · Actively being worked on</sub>
</p>

## Why I’m building this

I’m building **Rufajx-DSH to help my dad’s company work more efficiently**, both in the office and on the design side.

The idea is pretty simple: if someone needs to organize a spreadsheet, prepare a presentation, find information in a document, or work on a SolidWorks model, they should be able to explain what they need in normal language. They shouldn’t have to learn programming or set up a collection of AI tools first.

That’s what I’m trying to bring together here: a Windows app that fits around the files, software, and accounts people already use at work. I’m approaching it as a student project with a very practical goal—make something useful for my dad and the people he works with. I’m learning as I go, and there’s still plenty to improve.

**The goal is less repetitive work, more time for the parts that need a person’s judgment.**

## What it can help with

<table>
<tr>
<td width="50%" valign="top">
<h3>01 · Everyday office work</h3>
<p>Work with spreadsheets, documents, presentations, PDFs, and scanned text. Keep the conversation close to the files instead of copying everything between separate tools.</p>
</td>
<td width="50%" valign="top">
<h3>02 · Step-by-step CAD work</h3>
<p>Connect to SolidWorks 2016, plan a task, work through modeling steps, and inspect the results. Keep one dedicated, visible instance through a conversation so the process is easier to follow.</p>
</td>
</tr>
<tr>
<td valign="top">
<h3>03 · A hand on the computer</h3>
<p>Give desktop actions to a separate computer-use agent. A small overlay shows the current step even when the main app is in the background. Press Esc to stop.</p>
</td>
<td valign="top">
<h3>04 · A way back for files</h3>
<p>Save earlier versions before supported file changes, see what changed, and restore an older version. The history is shown as a branch tree, with ordinary labels instead of Git terminology.</p>
</td>
</tr>
<tr>
<td valign="top">
<h3>05 · Projects, media, and preferences</h3>
<p>Keep projects and reference folders organized, save explicit working preferences, preview audio and video, and use the bundled Remotion skill for video-making tasks.</p>
</td>
<td valign="top">
<h3>06 · One app for the company</h3>
<p>Employees use their company accounts. Administrators get account controls, conversation search, a readable history viewer, and recorded model usage. Model API keys stay on the server.</p>
</td>
</tr>
</table>

These are capabilities in the code, not a promise that every file, video format, or CAD operation will work perfectly. Important documents and engineering results still need a person to check them.

## A look inside

The screenshots below are **the real management interface running with synthetic test data**. Names, conversation contents, and usage numbers are examples, not employee records or production metrics. The app’s current interface is mainly Chinese.

### A quick view of the workspace

Accounts, saved conversations, and recorded usage in one place, so it’s easier to see how the app is being used.

<p align="center">
  <img src="docs/assets/admin-overview.png" alt="Management overview showing account status, saved conversations and model usage with synthetic data" width="100%">
</p>

### Conversations you can actually read

Find a conversation, read the full reply, and open the details when needed. Tables stay tables, long histories can continue loading, and the viewer makes it clear how much has been loaded.

<p align="center">
  <img src="docs/assets/admin-readable-reply.png" alt="Read-only conversation viewer with a formatted supplier comparison table and a visible history loading count" width="100%">
</p>

## The kind of requests I’m building for

| At work | An example request |
| --- | --- |
| Preparing for a meeting | “Use these spreadsheets to make a short presentation. Flag anything that needs checking.” |
| Comparing information | “Compare these supplier documents and put the differences into a table.” |
| Working on a design | “Help me model this mounting bracket in SolidWorks 2016. Let’s check each main step.” |
| Doing a desktop task | “Open the browser, find the official product manual, and download it to this project.” |
| Picking up a task later | “Continue from where we stopped, but check what has already been done first.” |

These are a few example prompts to start with. The available tools, input files, and local software determine what can be completed.

## How it fits together

<p align="center">
  <img src="docs/assets/how-it-works.svg" alt="The Windows app runs local tools, the company server manages accounts and saved records, and model requests go through the company gateway" width="100%">
</p>

The Windows app handles local files, desktop actions, and CAD tools. The company server handles login, permissions, saved conversation events, and the connection to the model service.

A few details matter to me:

- **Employees don’t need their own model API keys.** Model requests go through the company server.
- **Local actions still go through tool approval.** A company login isn’t permission to do anything on the computer.
- **Computer-use details stay in a separate task.** The main conversation gets a shorter result instead of every screenshot and click.
- **CAD work should be visible and continuous.** The dedicated instance is kept between steps; existing user windows and unsaved models aren’t automatically taken over.
- **Updates should be less disruptive.** The update code can reuse unchanged files, show progress, and retain a compatibility path for older installers. Some upgrades still need a full package.

Conversation sync is not a backup of every file on a computer. File-version protection also has a defined scope; it is not a whole-drive backup.

## Try the source

> **This repository is a source release, not a ready-to-install public app.** The employee experience I’m aiming for is “install, sign in, and work.” Building that complete package from this repository takes additional setup.

The public copy uses `https://dsh.example.com` as a placeholder. It does not connect you to my dad’s company service, and it includes no company accounts, credentials, conversations, or business files.

For a first look at the code, use **Node.js 24.16.0** and a local disk checkout:

```powershell
git clone https://github.com/Ha22yX/Rufajx-DSH.git
cd Rufajx-DSH
npm ci --ignore-scripts
npm run build
npm run typecheck
npm test --workspace @rufa/server
npm run test:integration
```

This compiles the company client and server and runs simulated checks. It does **not** prepare the full Harness environment or produce a Windows installer. Full desktop builds also need the pinned upstream, bundled dependencies, update configuration, and the documented SolidWorks inputs.

| If you want to… | Start here |
| --- | --- |
| Explore the code and run checks | [Development guide](docs/development.md) |
| Set up your own company server | [Server setup](docs/server.md) |
| Build the complete Windows client | [Client build guide](docs/client.md) |
| Understand the CAD integration | [SolidWorks toolkit](docs/solidworks-toolkit.md) |
| See what was checked | [Source validation notes](docs/validation.md) |
| Understand what is included | [Public source scope](docs/public-source.md) |

The detailed engineering notes are currently mostly in Chinese. This README is the English introduction; the [Chinese README](README.zh-CN.md) covers the same project overview.

<details>
<summary><strong>A small map of the code</strong></summary>

```text
apps/
  client/       Windows app, interface, local tools, and updater
  server/       Accounts, model gateway, conversation storage, and admin APIs
preinstalled/   Pinned plugin inputs, desktop overlay, and CAD references
scripts/        Build preparation, compatibility patches, and checks
tests/          Simulated integration tests and opt-in desktop tests
infra/          Deployment templates with no real credentials
docs/           Setup guides and implementation notes
```

The desktop uses **Electron and TypeScript**. The company service uses **Node.js, Fastify, and SQLite** by default. **DeepSeek Harness** provides the agent foundation, with local Python and native Windows helpers for some tools.

</details>

## Where the project is now

This is an ongoing project, and this public repository is a cleaned source snapshot. Some parts need more testing on different machines and real work tasks.

- The initial source checks passed locally: **189 server tests, 42 selected client tests, and 7 cross-end tests**. One test requiring the full Harness runtime was skipped. The [validation notes](docs/validation.md) explain the scope and known dependency warnings.
- **SolidWorks 2016 must already be installed and licensed.** The app doesn’t include SolidWorks or its license. Interface metadata is generated from a local installation; it isn’t shipped in this public repository.
- **Video tools have their own requirements and licenses.** The Remotion skill doesn’t include a commercial Remotion license.
- **A passing source check isn’t full desktop acceptance.** Installers, local tools, playback, updates, and CAD need their own isolated tests.

The next things I want to focus on are making setup easier to reproduce, explaining errors more clearly, and getting feedback on the office and design tasks people actually need help with.

## Built with help from

This project depends on a lot of other people’s work. **DeepSeek Harness provides the agent foundation; my work here is putting the company workflow around it.**

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — the foundation for the agent workspace.
- [dsh-computer-use-win](https://github.com/Yu-tao-Li/dsh-computer-use-win) — Windows computer-use tooling.
- [claude-remotion-skill](https://github.com/haidrrrry/claude-remotion-skill) — the starting point for the video-making skill.
- [DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar), [dsh-read-pdf](https://github.com/xiaoxuPekingUniversity/dsh-read-pdf), and the other plugin authors — useful pieces that make the workspace more complete.

The exact versions and sources are recorded in the lock files. See [third-party notices](THIRD_PARTY_NOTICES.md) for the broader list and license references.

### A note about licensing

I haven’t added a general open-source license for the project’s own code yet. The repository is public, but please check [NOTICE](NOTICE.md) before reusing or redistributing it. Third-party components keep their own licenses; the company branding and commercial software licenses are separate.

---

<p align="center">
  <strong>Made for my dad’s company. Still learning, still improving.</strong><br>
  <sub>If you spot something confusing or have a practical idea, I’d be glad to hear it in an <a href="https://github.com/Ha22yX/Rufajx-DSH/issues">issue</a>. Please leave out private company data.</sub>
</p>
