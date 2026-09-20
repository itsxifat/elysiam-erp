---
paths:
  - 'apps/console/**'
  - 'apps/portal/**'
  - 'apps/pos/**'
  - 'apps/sites/**'
  - 'packages/ui/**'
  - 'packages/landing-blocks/**'
---

# Frontend rules

## Design (architecture §24, D-033)

The bar is a tool people trust and operate for eight hours: restrained, dense, fast. Not decorated.

- Every colour, radius, shadow, duration and font size comes from the tokens in `packages/ui/src/styles/tokens.css`. Never hard-code one, and never reach for a raw Tailwind palette colour (`bg-blue-500`) in app code — use the semantic token (`bg-primary`, `text-muted-foreground`, `border-border`).
- Neutral chrome, one accent. Colour means status, money direction or danger, never decoration.
- Density: 36 px table rows and a tight type scale. Compactness comes from the scale, not from cutting the padding around the content region.
- Separation is a 1 px `border-border` hairline. Shadows appear only on floating layers: popover, dialog, command palette, toast.
- Light and dark are maintained together. Adding a token means adding both values.
- Motion is 120–200 ms ease-out, on enter, exit and state change only, and honours `prefers-reduced-motion`.
- Loading is a skeleton shaped like the content it replaces. A bare spinner is a last resort.
- Money, quantities and metric tiles use tabular numerals and right alignment.
- Accessibility floor: WCAG AA contrast in both themes, a visible focus ring on every interactive element, focus trapped and restored in dialogs, accessible names on icon-only buttons, and a label beside every status colour.
- Per-org branding (D-034) is data: accent, logo and login branding read from `org.organizations.brand`. Never fork a component per brand.

## Stack

- Styling: shadcn/ui components and Tailwind utility classes only. No CSS modules, styled-components or inline style objects. Re-tune a shadcn component to the tokens when you adopt it; don't leave it at library defaults.
- Icons: lucide-react only, at a consistent stroke width and size. Never use emojis as UI elements.
- Text: every user-facing string goes through `packages/i18n` keys, with values in both bn and en. The staff console defaults to en; customer-facing output is bn (D-036).
- Fonts: Inter for Latin and numerals, Hind Siliguri for Bangla, self-hosted with `size-adjust` so mixed bn/en strings share one baseline.
- Money renders through `<Money>` / `formatMoney` (৳, lakh/crore grouping). Dates display in Asia/Dhaka time.
- Server data comes through the generated `api-client` and TanStack Query. List filters live in URL search params (TanStack Router).
- Forms use React Hook Form with the shared Zod schema from `packages/contracts`.
- Use the shared CASL definitions to hide actions a role can't take. Treat the server as the only real permission check.
- Every screen handles loading, empty, error and permission-denied states.
- The order desk and POS are keyboard-first. Code-split every route.
