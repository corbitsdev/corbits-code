# Iconography

## Icon Pack

**Library:** [Lucide](https://lucide.dev/)

- **Install:** `bun add lucide-react`
- **Stroke width:** 2px
- **Size:** 24px

Lucide uses one of the most permissive licenses available. No attribution required, no restrictions on commercial use. This removes legal friction for any project, proprietary or open source.

Official packages for React, Vue, Svelte, Angular, and more. Only the icons you use end up in your bundle. For open source libraries and apps that care about bundle size, this is a real advantage over icon fonts or monolithic sprite sheets.

## TypeScript

Lucide exports types for full type safety when working with icons in TypeScript.

**Key types:**

| Type | Use |
|------|-----|
| `LucideProps` | Props interface for icon components (size, color, strokeWidth, SVG attrs) |
| `LucideIcon` | Type for an icon component — use when passing icons as props |
| `IconNode` | Raw SVG node structure for custom icons |

**Typing icon props in component interfaces:**

```typescript
import { type LucideIcon } from 'lucide-react';

interface ButtonProps {
  icon: LucideIcon;
  label: string;
}

const IconButton = ({ icon: Icon, label }: ButtonProps) => (
  <button aria-label={label}>
    <Icon size={16} />
  </button>
);
```

**Typing wrapper components:**

```typescript
import { type LucideProps } from 'lucide-react';
import { Camera } from 'lucide-react';

const WrapIcon = (props: LucideProps) => {
  return <Camera {...props} />;
};
```

See the full [TypeScript guide](https://lucide.dev/guide/react/advanced/typescript) for advanced patterns including custom icons with `IconNode`.
