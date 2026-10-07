# AIRewards Browser Extension

Official Chrome, Brave, Edge, and Arc browser extension for [AIRewards](https://www.airewards.tech), the AI-native, privacy-first advertising network.

## Overview

The AIRewards browser extension displays lightweight, non-intrusive, text-only sponsored messages in browser-based AI chats (**ChatGPT**, **Claude**, **Gemini**, **Grok**). Earners receive a 50% revenue share for verified impressions.

- **Manifest V3:** Built using modern Chrome Extension standards.
- **Privacy-First:** Never reads, stores, or transmits the content of your AI conversations, prompts, or code.
- **Cookie Authentication:** Uses standard HttpOnly cross-site session cookies—no API keys or JWTs stored in the extension.

## Supported AI Platforms

- **ChatGPT** (`chatgpt.com`)
- **Claude** (`claude.ai`)
- **Google Gemini** (`gemini.google.com`)
- **xAI Grok** (`grok.com`, `x.com/i/grok`)

## Installation

### Method 1: Load Unpacked in Chrome / Brave / Edge
1. Clone this repository:
   ```bash
   git clone https://github.com/airewards/browser-extension.git
   cd browser-extension
   ```
2. Install dependencies & build:
   ```bash
   npm install
   npm run build
   ```
3. Open `chrome://extensions` in your browser.
4. Enable **Developer mode** (toggle in top right).
5. Click **Load unpacked** and select the `dist/` directory.

### Method 2: Sign In & Earn
1. Click the AIRewards icon in your browser toolbar.
2. Click **Sign in with GitHub** to connect your account.
3. Use ChatGPT, Claude, Gemini, or Grok as normal—you'll see an unobtrusive sponsored mention at the bottom of AI responses.
4. View your accrued balance directly in the popup or dashboard.

## Security & Privacy Guarantee

- Scoped permissions: Requests only `storage` and host access to `https://www.airewards.tech` and supported AI domains for DOM placement.
- No analytics trackers or 3rd-party ad SDKs.
- Operates entirely on cryptographic challenge-response impression verification.

## License

MIT © [AIRewards](https://www.airewards.tech)
