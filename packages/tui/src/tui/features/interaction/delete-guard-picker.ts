import { formatTuiDeleteGuardLabel } from '../../../application/permission-mode.js';
import { getKeybindings, matchesKey } from '../../engine/public.js';
import type { Component } from '../../rendering/component.js';
import { truncateToWidth, visibleWidth } from '../../rendering/text.js';
import { tuiChalk as chalk, tuiColors as colors } from '../../theme/runtime.js';
import { questionnaireFrameContentWidth, renderQuestionnaireFrame } from './decision-frame.js';

/**
 * The destructive-delete guard lives behind its own command rather than inside
 * the permission picker: permission mode answers "when do I get asked", this
 * answers "are deletes recoverable at all". Mixing the two would let cycling to
 * Full access silently disarm irreversibility protection.
 */
const GUARD_OPTIONS = [true, false] as const;

const OPTION_LABELS: Record<'true' | 'false', string> = {
  true: 'Recoverable',
  false: 'Permanent',
};

const OPTION_DESCRIPTIONS: Record<'true' | 'false', string> = {
  true: 'Deletes move to trash and can be restored',
  false: 'Deletes are permanent and cannot be undone',
};

export class TuiDeleteGuardPicker implements Component {
  private selectedIndex: number;

  constructor(
    /**
     * Read live rather than captured: toggling this guard does not close the
     * picker, so a constructor snapshot would immediately show a stale state.
     */
    private readonly readEnabled: () => boolean | undefined,
    private readonly onSelect: (enabled: boolean) => void,
    private readonly onCancel: () => void,
    private readonly requestRender: () => void = () => undefined,
  ) {
    const current = readEnabled();
    const index = GUARD_OPTIONS.findIndex((option) => option === current);
    this.selectedIndex = index >= 0 ? index : 0;
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'up')) {
      this.selectedIndex =
        this.selectedIndex === 0 ? GUARD_OPTIONS.length - 1 : this.selectedIndex - 1;
      this.requestRender();
      return;
    }
    if (matchesKey(data, 'down')) {
      this.selectedIndex = (this.selectedIndex + 1) % GUARD_OPTIONS.length;
      this.requestRender();
      return;
    }
    if (/^[1-2]$/u.test(data)) {
      const option = GUARD_OPTIONS[Number(data) - 1];
      if (option !== undefined) this.onSelect(option);
      return;
    }
    if (matchesKey(data, 'enter') || matchesKey(data, 'space')) {
      const option = GUARD_OPTIONS[this.selectedIndex];
      if (option !== undefined) this.onSelect(option);
      return;
    }
    if (getKeybindings().matches(data, 'tui.select.cancel')) this.onCancel();
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    if (safeWidth === 0) return [];
    const contentWidth = questionnaireFrameContentWidth(safeWidth);
    const compact = contentWidth < 56;
    const current = this.readEnabled();
    const currentLabel = formatTuiDeleteGuardLabel(current);
    return renderQuestionnaireFrame(
      {
        title: safeWidth < 42 ? `Delete guard · ${currentLabel}` : 'Delete guard',
        ...(safeWidth >= 42 ? { meta: `Current · ${currentLabel}` } : {}),
        body: [
          chalk.hex(colors.muted)(
            compact
              ? 'Choose how deletes behave.'
              : 'Choose whether agent deletes stay recoverable.',
          ),
          '',
          ...GUARD_OPTIONS.flatMap((option, index) =>
            renderOption(option, {
              active: option === current,
              focused: index === this.selectedIndex,
              compact,
              width: contentWidth,
            }),
          ),
        ],
        footer:
          safeWidth < 42 ? '↑/↓ move · Enter · Esc' : '↑/↓ select · Enter apply · Esc cancel',
      },
      safeWidth,
      'signal',
    );
  }
}

function renderOption(
  option: boolean,
  options: {
    readonly active: boolean;
    readonly focused: boolean;
    readonly compact: boolean;
    readonly width: number;
  },
): string[] {
  const key = String(option) as 'true' | 'false';
  const prefix = options.focused ? chalk.bold.hex(colors.signal)('›') : ' ';
  // "Permanent" is the state that can lose data for good, so it carries the
  // same warning colour Full access uses rather than reading as a neutral option.
  const labelColor = options.focused
    ? colors.signal
    : option === false
      ? colors.error
      : colors.text;
  const label = (options.focused ? chalk.bold : chalk).hex(labelColor)(
    OPTION_LABELS[key].toUpperCase().slice(0, 4).padEnd(4),
  );
  const status = [
    option === false ? chalk.hex(colors.error)('⚠') : '',
    options.active ? chalk.hex(colors.signal)('● active') : '',
  ]
    .filter(Boolean)
    .join(' ');
  const description = chalk.hex(colors.muted)(OPTION_DESCRIPTIONS[key]);
  const heading = `${prefix} ${label}`;

  if (options.compact) {
    return [
      fitWithRightMeta(heading, status, options.width),
      truncateToWidth(`  ${description}`, options.width, ''),
    ];
  }
  return [fitWithRightMeta(`${heading}  ${description}`, status, options.width)];
}

function fitWithRightMeta(content: string, meta: string, width: number): string {
  if (!meta) return truncateToWidth(content, width, '');
  const gap = width - visibleWidth(content) - visibleWidth(meta);
  if (gap >= 2) return `${content}${' '.repeat(gap)}${meta}`;
  const contentWidth = Math.max(0, width - visibleWidth(meta) - 2);
  return `${truncateToWidth(content, contentWidth, '')}  ${meta}`;
}
