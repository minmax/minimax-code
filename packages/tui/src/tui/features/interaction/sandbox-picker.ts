import {
  formatTuiSandboxModeCompactLabel,
  formatTuiSandboxModeLabel,
  describeTuiSandboxMode,
  isCautionaryTuiSandboxMode,
  TUI_SANDBOX_FILESYSTEM_MODES,
  type TuiSandboxFilesystemMode,
} from '../../../application/sandbox-mode.js';
import { getKeybindings, matchesKey } from '../../engine/public.js';
import type { Component } from '../../rendering/component.js';
import { truncateToWidth, visibleWidth } from '../../rendering/text.js';
import { tuiChalk as chalk, tuiColors as colors } from '../../theme/runtime.js';
import { questionnaireFrameContentWidth, renderQuestionnaireFrame } from './decision-frame.js';

/**
 * The sandbox filesystem level lives behind its own command rather than inside
 * the permission picker: permission mode answers "when do I get asked", the
 * sandbox answers "what is reachable at all", and they are enforced by
 * different layers. Folding them together would let cycling to Full access
 * read as if it had also lifted the filesystem restrictions.
 */
export class TuiSandboxPicker implements Component {
  private selectedIndex: number;

  constructor(
    /**
     * Read live rather than captured: applying a level does not close the
     * picker, so a constructor snapshot would immediately show a stale state.
     */
    private readonly readMode: () => TuiSandboxFilesystemMode | undefined,
    private readonly onSelect: (mode: TuiSandboxFilesystemMode) => void,
    private readonly onCancel: () => void,
    private readonly requestRender: () => void = () => undefined,
  ) {
    const current = readMode();
    const index = TUI_SANDBOX_FILESYSTEM_MODES.findIndex((mode) => mode === current);
    this.selectedIndex = index >= 0 ? index : 0;
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'up')) {
      this.selectedIndex =
        this.selectedIndex === 0
          ? TUI_SANDBOX_FILESYSTEM_MODES.length - 1
          : this.selectedIndex - 1;
      this.requestRender();
      return;
    }
    if (matchesKey(data, 'down')) {
      this.selectedIndex = (this.selectedIndex + 1) % TUI_SANDBOX_FILESYSTEM_MODES.length;
      this.requestRender();
      return;
    }
    const digit = Number.parseInt(data, 10);
    if (/^[1-4]$/u.test(data)) {
      const option = TUI_SANDBOX_FILESYSTEM_MODES[digit - 1];
      if (option !== undefined) this.onSelect(option);
      return;
    }
    if (matchesKey(data, 'enter') || matchesKey(data, 'space')) {
      const option = TUI_SANDBOX_FILESYSTEM_MODES[this.selectedIndex];
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
    const current = this.readMode();
    const currentLabel = formatTuiSandboxModeLabel(current);
    return renderQuestionnaireFrame(
      {
        title: safeWidth < 42 ? `Sandbox · ${currentLabel}` : 'Sandbox filesystem',
        ...(safeWidth >= 42 ? { meta: `Current · ${currentLabel}` } : {}),
        body: [
          chalk.hex(colors.muted)(
            compact
              ? 'Choose what the sandbox allows.'
              : 'Choose what the sandbox allows independently of permission mode.',
          ),
          '',
          ...TUI_SANDBOX_FILESYSTEM_MODES.flatMap((mode, index) =>
            renderOption(mode, {
              active: mode === current,
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
  mode: TuiSandboxFilesystemMode,
  options: {
    readonly active: boolean;
    readonly focused: boolean;
    readonly compact: boolean;
    readonly width: number;
  },
): string[] {
  const prefix = options.focused ? chalk.bold.hex(colors.signal)('›') : ' ';
  // The unrestricted level carries the same warning colour Full access uses in
  // the permission picker; the read-only level warns on the other side of the
  // trade-off, because it reads as cautious while it stops the agent working.
  const labelColor = options.focused
    ? colors.signal
    : isCautionaryTuiSandboxMode(mode)
      ? colors.error
      : colors.text;
  const label = (options.focused ? chalk.bold : chalk).hex(labelColor)(
    formatTuiSandboxModeCompactLabel(mode),
  );
  const status = [
    isCautionaryTuiSandboxMode(mode) ? chalk.hex(colors.error)('⚠') : '',
    options.active ? chalk.hex(colors.signal)('● active') : '',
  ]
    .filter(Boolean)
    .join(' ');
  const description = chalk.hex(colors.muted)(describeTuiSandboxMode(mode));
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