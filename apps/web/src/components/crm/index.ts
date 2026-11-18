// The shared CRM UI kit. Import from '@/components/crm'; formatting helpers are in '@/lib/crm/format'.
// See every component with sample data at /dev/ui-kit (development only).

export { AvatarGroup, type AvatarPerson } from './AvatarGroup';
export { ChannelBadge, NewBadge, SlaBadge, StatusPill, channelIcon, type PillTone } from './Badges';
export { Board, BoardCard, BoardColumn, type BoardColumnRef } from './Board';
export { BulkActionBar } from './BulkActionBar';
export {
  DataTable,
  infiniteRows,
  type Breakpoint,
  type Column,
  type DataTableProps,
  type InfiniteListQuery,
  type RowSelection,
  type SortDirection,
  type SortState,
} from './DataTable';
export { DateTime, Masked, Money, Mono, RelativeTime } from './Display';
export { ChipGroup, FilterBar, SearchInput, type ChipGroupProps, type ChipOption, type FilterBarProps } from './FilterBar';
export { useModifierKey, useNow, useRowSelection } from './hooks';
export { Kbd } from './Kbd';
export { KeyValue, type KeyValueItem } from './KeyValue';
export { Menu, Popover, useAnchoredPanel, type MenuItem, type Placement, type PopoverTriggerProps } from './Popover';
export { SavedViewsMenu, type SavedView } from './SavedViewsMenu';
export { Section } from './Section';
export { SidePanel } from './SidePanel';
export { StageBubbles, stageStates, type StageBubble, type StageOutcome } from './StageBubbles';
export { Tabs, type TabItem } from './Tabs';
export { UserPicker, userPickerKey, type PickedUser } from './UserPicker';
