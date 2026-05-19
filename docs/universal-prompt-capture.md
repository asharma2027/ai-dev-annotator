# Universal Prompt Capture

Universal Prompt Capture turns AI Website Dev Annotator into a prompt-only capture layer for apps beyond Chrome.

The core rule is intentionally strict:

> Capture context and save prompts. Do not execute prompts, click UI, type into apps, call AI APIs, or mutate external applications.

This keeps the project model-agnostic. Users can paste the exported Markdown into Cursor, Claude Code, ChatGPT, Copilot, Gemini, or whatever agent they prefer later.

## What this branch adds

The popup loads `universal-import.js`, which adds two controls above the normal annotation list:

- **Import App Captures**: paste structured JSON from a native helper, simulator bridge, IDE extension, Figma plugin, or any other adapter.
- **Copy App Prompts**: export only imported cross-app captures as Markdown.

Imported app captures are saved to `chrome.storage.local` under the existing `annotations` key, so they benefit from the existing local-first storage model. Each imported annotation also carries a `universalCapture` object with the original source and target metadata.

## Capture schema

Minimum viable payload:

```json
{
  "version": 1,
  "source": {
    "adapter": "macos-accessibility",
    "appName": "MyApp",
    "bundleId": "com.example.myapp",
    "windowTitle": "Settings"
  },
  "captures": [
    {
      "target": {
        "kind": "button",
        "name": "Export",
        "stableRef": "AXWindow/AXToolbar/AXButton[Export]",
        "visibleText": "Export"
      },
      "prompt": "Rename this to Export CSV and disable it until invoices are loaded."
    }
  ]
}
```

Supported source fields are intentionally flexible:

- `adapter`: where the capture came from, such as `macos-accessibility`, `windows-uia`, `ios-simulator`, `android-uiautomator`, `vscode`, or `figma`.
- `appName`: human-readable app name.
- `bundleId` or `packageName`: stable app identifier.
- `windowTitle`: current window, screen, or activity title.
- `documentName`: document, design file, repo, or deck name.
- `url` or `deepLink`: optional source link.

Supported target fields:

- `kind`, `role`, or `type`: target category, such as `button`, `text-field`, `frame`, `file-range`, or `issue`.
- `name`, `label`, or `title`: human-readable target name.
- `stableRef`: best available stable reference.
- `accessibilityPath`: native app accessibility hierarchy path.
- `resourceId`: Android resource ID.
- `nodeId`: Figma or document object ID.
- `filePath`: IDE/repo path.
- `visibleText`: text visible around the target.

Each capture must include `prompt`, `note`, or `comment`.

## Realistic adapter examples

### macOS desktop QA

```json
{
  "version": 1,
  "source": {
    "adapter": "macos-accessibility",
    "appName": "Acme Desktop",
    "bundleId": "com.acme.desktop",
    "windowTitle": "Billing Settings"
  },
  "captures": [
    {
      "target": {
        "kind": "button",
        "name": "Export",
        "accessibilityPath": "AXApplication/AXWindow[Billing Settings]/AXGroup/AXToolbar/AXButton[Export]",
        "visibleText": "Export"
      },
      "prompt": "Rename this button to Export CSV and add a disabled state while invoices are loading."
    }
  ]
}
```

### iOS simulator

```json
{
  "version": 1,
  "source": {
    "adapter": "ios-simulator",
    "appName": "Acme iOS",
    "bundleId": "com.acme.ios",
    "windowTitle": "Checkout"
  },
  "captures": [
    {
      "target": {
        "kind": "label",
        "name": "Checkout total",
        "stableRef": "accessibilityIdentifier=checkout_total_label",
        "visibleText": "$0.00"
      },
      "prompt": "Fix the state derivation so this total updates when quantity changes. Add a regression UI test."
    }
  ]
}
```

### Android emulator

```json
{
  "version": 1,
  "source": {
    "adapter": "android-uiautomator",
    "appName": "Acme Android",
    "packageName": "com.acme.android",
    "windowTitle": "LoginActivity"
  },
  "captures": [
    {
      "target": {
        "kind": "button",
        "name": "Continue",
        "resourceId": "com.acme.android:id/login_button",
        "visibleText": "Continue"
      },
      "prompt": "Add a loading state and prevent double-tap submission."
    }
  ]
}
```

### VS Code / IDE

```json
{
  "version": 1,
  "source": {
    "adapter": "vscode",
    "appName": "VS Code",
    "documentName": "acme-dashboard",
    "windowTitle": "CheckoutSummary.tsx"
  },
  "captures": [
    {
      "target": {
        "kind": "file-range",
        "name": "CheckoutSummary total calculation",
        "filePath": "src/components/CheckoutSummary.tsx:42-81",
        "visibleText": "Type 'undefined' is not assignable to type 'Money'."
      },
      "prompt": "Fix the state derivation without changing the public props API. Add a regression test."
    }
  ]
}
```

### Figma

```json
{
  "version": 1,
  "source": {
    "adapter": "figma",
    "appName": "Figma",
    "documentName": "Marketing Site Redesign",
    "windowTitle": "Homepage"
  },
  "captures": [
    {
      "target": {
        "kind": "frame-node",
        "name": "Hero / CTA Button",
        "nodeId": "12:431",
        "visibleText": "Start free trial"
      },
      "prompt": "Implement this button in React. Preserve the 16px radius, 48px height, hover state, and text style."
    }
  ]
}
```

## Adapter contract

Adapters should only produce JSON. They should not send the prompt to an AI provider.

A native helper or plugin should do this:

1. Identify the currently selected/clicked target.
2. Read stable metadata for that target.
3. Ask the user for a note/prompt.
4. Produce JSON matching the schema above.
5. Let the user paste or import that JSON into the extension.

Adapters should not do this:

- click controls
- type into apps
- submit forms
- run shell commands
- edit files
- call AI APIs
- send captured data to an app server by default

## Markdown output

`Copy App Prompts` produces Markdown grouped by source app/document. It includes:

- source adapter
- app identifier
- window/screen/document
- stable target reference
- visible text
- user prompt
- capture timestamp

The output is designed to be pasted into any AI agent while preserving enough target context for the agent to reason about the requested change.
