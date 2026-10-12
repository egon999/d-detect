# D-Detect: Codebase Structure & Module Walkthrough

This document provides a component-by-component tour of the **D-Detect** codebase, explaining the layout, organization, and primary functional roles of each source directory.

---

## 1. Directory Tree Overview

```
detact/
├── android/               # Native Android build configuration & keystores
├── app/                   # Expo Router screens & route layouts
│   ├── (tabs)/            # Main bottom-tab navigation screens
│   │   ├── index.tsx      # Chronological Daybook Timeline feed
│   │   ├── money.tsx      # Financial analytics & budget cards
│   │   ├── tasks.tsx      # Tasks, action items & reminders
│   │   └── you.tsx        # Profile, settings & diagnostics reporter
│   ├── _layout.tsx        # Root navigation stack, theme providers & splash gate
│   ├── ask.tsx            # Natural language query assistant interface
│   ├── capture.tsx        # File, photo & note capture bottom sheet
│   ├── sign-in.tsx        # Google OAuth & guest authentication screen
│   └── meeting/           # Meeting audio recording & processing screens
├── assets/                # App icons, splash screens & visual resources
├── server/                # Node.js backend server
│   ├── src/
│   │   ├── index.ts       # Server entry point & port binding
│   │   ├── app.ts         # Middleware configuration & route mounting
│   │   ├── auth.ts        # Authentication verification & tenant resolution
│   │   ├── db.ts          # SQLite connection pool, schemas & migrations
│   │   ├── routes/        # REST API route controllers
│   │   │   ├── account.ts # User profile, export & deletion routes
│   │   │   ├── assistant.ts # /ask conversational query engine
│   │   │   ├── daybook.ts # Chronological timeline records CRUD
│   │   │   ├── files.ts   # Binary file storage & HMAC sealing
│   │   │   ├── insights.ts # Financial aggregation & budget logic
│   │   │   └── meetings.ts # Audio meeting processing & transcription
│   │   └── signals/       # Duplicate payment & anomaly detection algorithms
│   └── package.json       # Backend dependencies & test scripts
├── src/                   # Client-side core logic & UI library
│   ├── api/               # Typed HTTP client modules interfacing with server
│   ├── data/              # Firebase integration (Firestore & Cloud Storage)
│   ├── services/          # Business logic, state providers, auth & reminders
│   └── ui/                # UI primitives, theme tokens & design system
│       ├── primitives/    # Reusable UI widgets (cards, buttons, mascot)
│       └── tokens.ts      # Colors, typography, spacing & border radii
└── tests/                 # Comprehensive client Vitest test suites (1,059 tests)
```

---

## 2. Core Modules Breakdown

### A. Mobile Application Layer (`app/`)
- `app/_layout.tsx`: Configures the root navigation stack, binds the theme provider, handles fonts initialization, and controls the animated splash screen.
- `app/sign-in.tsx`: Supports Google OAuth 2.0 and local guest sign-in with interactive feedback and fluid input styling.
- `app/(tabs)/index.tsx`: The primary home feed organizing user records into distinct date-banded cards.
- `app/(tabs)/money.tsx`: Aggregates transactions, visualizes spending patterns, and flags recurring expenses.
- `app/ask.tsx`: Provides a chat interface allowing users to converse with their evidence repository.

### B. Client Service Layer (`src/`)
- `src/api/client.ts`: Resilient fetch wrapper featuring timeout handling, offline caching, and user-friendly error formatting.
- `src/services/session-provider.tsx`: Coordinates active user session lifecycle, persistent storage tokens, and authentication state.
- `src/ui/primitives/DetectiveMascot.tsx`: Pure React Native vector animation featuring realistic blinking, fedora wobble physics, and micro-interactions.

### C. Server Backend Engine (`server/src/`)
- `server/src/db.ts`: Manages SQLite database lifecycles, runs schema setup, and maintains FTS5 virtual search tables.
- `server/src/routes/assistant.ts`: Powers the conversational assistant by combining full-text search with LLM reasoning.
- `server/src/routes/daybook.ts`: Handles CRUD operations for timeline records, verifying ownership on every request.
- `server/src/signals/anomalies.ts`: Implements forensic algorithms detecting missing recurring payments and suspicious duplicates.
