/**
 * @elysium/ui
 *
 * shadcn/ui components, the Tailwind preset, Bangla font setup and the
 * formatting components (architecture §4, §24).
 *
 * M00 shipped the design token foundation: the tokens, the Tailwind preset that
 * republishes them, and the colour maths the apps use to apply an org's brand
 * (D-034) and that CI uses to hold the accessibility floor. M05 adds the
 * component kit on top of it.
 *
 * Every component here resolves its colours, radii, sizes and durations through
 * those tokens and never through a raw Tailwind palette class. That is what
 * keeps light and dark in step by construction rather than by review, and it is
 * what lets an org's accent repaint at runtime.
 *
 * Stylesheets are imported by path, not from this entry point:
 *   import '@elysium/ui/styles/tailwind.css';
 */

export {
  contrastRatio,
  oklchToRgb8,
  pickAccessibleForeground,
  relativeLuminance,
  resolveBrandAccent,
  toHex,
  FOREGROUND_CANDIDATES,
  type BrandAccent,
  type BrandAccentInput,
  type Oklch,
  type Rgb8,
} from './tokens/contrast.js';

export {
  parseOklch,
  parseTokenFile,
  resolveToken,
  type TokenFile,
  type TokenScope,
} from './tokens/parse.js';

export {
  auditContrast,
  themeRoles,
  CONTRAST_PAIRS,
  type ContrastPair,
  type ContrastResult,
} from './tokens/audit.js';

// --- M05: the component kit -------------------------------------------------

export { cn } from './lib/cn.js';
export {
  readStored,
  STORAGE_KEYS,
  writeStored,
  type KeyValueStore,
  type StorageSlot,
} from './lib/storage.js';

export { Button, buttonVariants, type ButtonProps } from './components/button.js';
export { Money, type MoneyProps } from './components/money.js';
export { DateTime, type DateTimeProps } from './components/date-time.js';
export {
  StatusBadge,
  statusBadgeVariants,
  type StatusBadgeProps,
} from './components/status-badge.js';
export { PermissionGate, type PermissionGateProps } from './components/permission-gate.js';
export {
  EmptyState,
  ErrorState,
  PermissionDeniedState,
  Skeleton,
  Spinner,
} from './components/states.js';

export {
  Input,
  Label,
  controlClassName,
  type InputProps,
  type LabelProps,
} from './components/input.js';
export { Select, SelectContent, SelectItem, type SelectProps } from './components/select.js';
export {
  SearchInput,
  FilterChips,
  type ActiveFilter,
  type SearchInputProps,
} from './components/filters.js';
export {
  Card,
  DescriptionList,
  Hint,
  Kbd,
  Monogram,
  PageHeader,
  Section,
  TabList,
  Toolbar,
  initials,
  tabActiveClassName,
  tabClassName,
  type PageHeaderProps,
} from './components/layout.js';
export {
  Delta,
  MetricList,
  Sparkline,
  StatCard,
  type StatCardProps,
  type StatDelta,
} from './components/stat.js';
export { Sheet, type SheetProps } from './components/sheet.js';
export { Checkbox, type CheckboxProps } from './components/checkbox.js';
export {
  DatePicker,
  DateRangePicker,
  MonthPicker,
  type DatePickerLabels,
  type DatePickerProps,
  type DateRange,
  type DateRangePickerProps,
  type MonthPickerProps,
  type PickerLocale,
  type RangePreset,
  type YearSpan,
} from './components/date-picker.js';
export {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from './components/menu.js';
export {
  Dialog,
  ConfirmDialog,
  type DialogProps,
  type ConfirmDialogProps,
} from './components/dialog.js';
export { Popover, PopoverContent, PopoverTrigger } from './components/popover.js';
export {
  Form,
  FormField,
  type FieldRenderProps,
  type FormFieldProps,
  type FormProps,
} from './components/form.js';
export {
  ComboboxField,
  DateField,
  MoneyField,
  PhoneField,
  SelectField,
  TextField,
  normalizeBdPhone,
  poishaToTaka,
  takaToPoisha,
  type ComboboxFieldProps,
  type SelectOption,
} from './components/fields.js';
export {
  DataTable,
  dataTableColumns,
  dataTableFeatures,
  type DataTableColumn,
  type DataTableColumnMeta,
  type DataTableFeatures,
  type DataTableLabels,
  type DataTableProps,
  type SortDirection,
  type TablePage,
  type TableSort,
} from './components/data-table.js';
export {
  FileUpload,
  type FileUploadProps,
  type UploadedFile,
  type UploadTicket,
} from './components/file-upload.js';
