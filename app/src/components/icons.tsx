// Central icon set (Phosphor) so the whole app shares one crisp, consistent
// SVG vocabulary instead of emoji. Swap a glyph here and it changes everywhere.
//
// Phosphor v2.1+ uses the `*Icon`-suffixed exports (the bare names like `Gear`
// are deprecated). Weights (thin/light/regular/bold/fill/duotone) add richness.
import {
  StarIcon,
  TrayIcon,
  ClockIcon,
  ArrowBendUpLeftIcon,
  ArrowBendDoubleUpLeftIcon,
  ArrowBendUpRightIcon,
  NewspaperIcon,
  ReceiptIcon,
  CalendarBlankIcon,
  ListChecksIcon,
  GearIcon,
  SparkleIcon,
  PencilSimpleLineIcon,
  PaperPlaneTiltIcon,
  PaperclipIcon,
  ArrowsOutIcon,
  DotsThreeIcon,
  PlusIcon,
  XIcon,
  MagnifyingGlassIcon,
  CpuIcon,
  CloudIcon,
  HardDrivesIcon,
  PlugsIcon,
  CommandIcon,
  SunIcon,
  MoonIcon,
  CalendarPlusIcon,
  type Icon as PhosphorIcon,
  type IconWeight,
} from "@phosphor-icons/react";

export const Icons = {
  priority: StarIcon,
  inbox: TrayIcon,
  snoozed: ClockIcon,
  awaiting: ArrowBendUpLeftIcon,
  newsletters: NewspaperIcon,
  receipts: ReceiptIcon,
  calendar: CalendarBlankIcon,
  tasks: ListChecksIcon,
  settings: GearIcon,
  ai: SparkleIcon,
  compose: PencilSimpleLineIcon,
  send: PaperPlaneTiltIcon,
  attach: PaperclipIcon,
  focus: ArrowsOutIcon,
  more: DotsThreeIcon,
  reply: ArrowBendUpLeftIcon,
  replyAll: ArrowBendDoubleUpLeftIcon,
  forward: ArrowBendUpRightIcon,
  plus: PlusIcon,
  close: XIcon,
  search: MagnifyingGlassIcon,
  local: CpuIcon,
  cloud: CloudIcon,
  server: HardDrivesIcon,
  plug: PlugsIcon,
  command: CommandIcon,
  sun: SunIcon,
  moon: MoonIcon,
  schedule: CalendarPlusIcon,
} satisfies Record<string, PhosphorIcon>;

export type IconName = keyof typeof Icons;

export function Icon({
  name,
  size = 16,
  weight = "duotone",
  className,
}: {
  name: IconName;
  size?: number;
  weight?: IconWeight;
  className?: string;
}) {
  const Cmp = Icons[name];
  return <Cmp size={size} weight={weight} className={className} />;
}
