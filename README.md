# EasyCamp

Local web app for natural-language campsite availability alerts.

## Run

```powershell
npm start
```

Open `http://localhost:4173`.

## Share or Deploy

Public repository:

https://github.com/NolanBradberrysPortfolio/easycamp

For a hosted version, connect this repository to Render as a web service. The included `render.yaml` uses:

- build command: `npm install`
- start command: `npm start`
- runtime: Node

Add notification secrets in the hosting provider environment settings before enabling public alerts.

## What It Does

- Parses natural-language campsite alert requests into dates, location, features, and channels.
- Discovers campground targets through Recreation.gov search.
- Lets a user review the generated campground list before monitoring.
- Checks availability against Recreation.gov campground availability endpoints.
- Sends direct booking links by Telegram, email, or SMS when configured.
- Stores alerts and hits in `data/store.json`.

## Boundaries

- No Recreation.gov account handling.
- No CAPTCHA/human-verification handling.
- No payment data.
- No auto-booking.

## Notification Setup

Telegram works automatically if the existing `codex-anywhere` config is present. Alternatively set:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

Email uses Resend:

- `RESEND_API_KEY`
- `EMAIL_FROM`

SMS uses Twilio:

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_FROM_NUMBER`
