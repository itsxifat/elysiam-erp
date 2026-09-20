---
paths:
  - "apps/console/**"
  - "apps/portal/**"
  - "apps/pos/**"
  - "apps/sites/**"
  - "packages/ui/**"
  - "packages/landing-blocks/**"
---
# Frontend rules
- Styling: shadcn/ui components and Tailwind utility classes only. No CSS modules, styled-components or inline style objects.
- Icons: lucide-react only. Never use emojis as UI elements.
- Text: every user-facing string goes through `packages/i18n` keys, with values in both bn and en.
- Fonts must render Bangla: Hind Siliguri or Noto Sans Bengali, plus Inter.
- Money renders through `<Money>` / `formatMoney` (৳, lakh/crore grouping). Dates display in Asia/Dhaka time.
- Server data comes through the generated `api-client` and TanStack Query. List filters live in URL search params (TanStack Router).
- Forms use React Hook Form with the shared Zod schema from `packages/contracts`.
- Use the shared CASL definitions to hide actions a role can't take. Treat the server as the only real permission check.
- Every screen handles loading, empty, error and permission-denied states.
- The order desk and POS are keyboard-first. Code-split every route.
