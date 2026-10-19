// The editor's toolbar: always visible at the top of the frame. It shows the
// formatting at the caret or selection and applies text formats, links and
// block styles. The toggles are the flat Boxops ones, with the B, I and S
// letterforms for text formats and Phosphor glyphs for the rest.

import { Button } from '@astryxdesign/core/Button';
import { HStack } from '@astryxdesign/core/HStack';
import { Popover } from '@astryxdesign/core/Popover';
import { StackItem } from '@astryxdesign/core/Stack';
import { TextInput } from '@astryxdesign/core/TextInput';
import { ToggleButton } from '@astryxdesign/core/ToggleButton';
import { $createCodeNode, $isCodeNode } from '@lexical/code';
import { $createLinkNode, $isLinkNode, TOGGLE_LINK_COMMAND } from '@lexical/link';
import {
  $isListNode,
  INSERT_CHECK_LIST_COMMAND,
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
  ListNode,
  REMOVE_LIST_COMMAND,
  type ListType,
} from '@lexical/list';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $createQuoteNode, $isHeadingNode, $isQuoteNode } from '@lexical/rich-text';
import { $setBlocksType } from '@lexical/selection';
import { $findMatchingParent, $getNearestNodeOfType, IS_APPLE } from '@lexical/utils';
import { Code, CodeBlock, LinkSimple, ListBullets, ListChecks, ListNumbers, Quotes } from '@phosphor-icons/react';
import {
  $createParagraphNode,
  $createTextNode,
  $getSelection,
  $isRangeSelection,
  $isRootOrShadowRoot,
  $setSelection,
  COMMAND_PRIORITY_HIGH,
  FORMAT_TEXT_COMMAND,
  KEY_DOWN_COMMAND,
  type LexicalEditor,
  type RangeSelection,
  type TextFormatType,
} from 'lexical';
import { useCallback, useEffect, useRef, useState } from 'react';

const FORMATS: TextFormatType[] = ['bold', 'italic', 'strikethrough', 'code'];
const MOD = IS_APPLE ? '⌘' : 'Ctrl+';

type Block = 'paragraph' | 'heading' | 'quote' | 'code' | ListType;

interface Current {
  formats: Set<TextFormatType>;
  block: Block;
  /** The caret sits inside a link. */
  link: boolean;
  /** The selected text is itself a web address. */
  url: string | undefined;
}

function asUrl(text: string): string | undefined {
  const t = text.trim();
  if (/^(https?:\/\/|mailto:)\S+$/i.test(t)) return t;
  if (/^www\.\S+$/i.test(t)) return `https://${t}`;
  return undefined;
}

/** The block style of the selection's anchor: its top-level element, or the nearest list for list items. */
function $blockOf(selection: RangeSelection): Block {
  const anchor = selection.anchor.getNode();
  const top =
    anchor.getKey() === 'root'
      ? anchor
      : ($findMatchingParent(anchor, (n) => {
          const p = n.getParent();
          return p !== null && $isRootOrShadowRoot(p);
        }) ?? anchor.getTopLevelElementOrThrow());
  if ($isListNode(top)) return ($getNearestNodeOfType(anchor, ListNode) ?? top).getListType();
  if ($isHeadingNode(top)) return 'heading';
  if ($isQuoteNode(top)) return 'quote';
  if ($isCodeNode(top)) return 'code';
  return 'paragraph';
}

function read(editor: LexicalEditor): Current | null {
  return editor.getEditorState().read(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return null;
    return {
      formats: new Set(FORMATS.filter((f) => selection.hasFormat(f))),
      block: $blockOf(selection),
      link: !!$findMatchingParent(selection.anchor.getNode(), $isLinkNode),
      url: asUrl(selection.getTextContent()),
    };
  });
}

export function Toolbar({ isDisabled = false }: { isDisabled?: boolean }) {
  const [editor] = useLexicalComposerContext();
  const [cur, setCur] = useState<Current | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [url, setUrl] = useState('');
  // The address popover hangs below the toolbar, where there is always room.
  const bar = useRef<HTMLDivElement>(null as unknown as HTMLDivElement);
  // The selection the address popover was opened for, restored when it closes.
  const saved = useRef<RangeSelection | null>(null);

  useEffect(() => editor.registerUpdateListener(() => setCur(read(editor))), [editor]);

  // Runs an edit with the editor focused, so a toolbar click on an untouched
  // editor still lands at the end of its text.
  const act = useCallback(
    (fn: () => void) => {
      if (editor.getRootElement() === document.activeElement) fn();
      else editor.focus(fn);
    },
    [editor],
  );

  const format = (f: TextFormatType) => act(() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, f));

  const list = (type: ListType) =>
    act(() => {
      const now = read(editor);
      if (now?.block === type) editor.dispatchCommand(REMOVE_LIST_COMMAND, undefined);
      else if (type === 'bullet') editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined);
      else if (type === 'number') editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined);
      else editor.dispatchCommand(INSERT_CHECK_LIST_COMMAND, undefined);
    });

  const block = (type: 'quote' | 'code') =>
    act(() =>
      editor.update(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return;
        if ($blockOf(selection) === type) {
          $setBlocksType(selection, () => $createParagraphNode());
        } else if (type === 'quote') {
          $setBlocksType(selection, () => $createQuoteNode());
        } else if (selection.isCollapsed()) {
          $setBlocksType(selection, () => $createCodeNode());
        } else {
          // A span of text becomes the body of one code block.
          const text = selection.getTextContent();
          const code = $createCodeNode();
          selection.insertNodes([code]);
          const inner = $getSelection();
          if ($isRangeSelection(inner)) inner.insertRawText(text);
        }
      }),
    );

  // Link: unlink inside a link, link a selected address outright, otherwise
  // ask for the address.
  const link = useCallback(() => {
    const now = read(editor);
    if (now?.link) return act(() => editor.dispatchCommand(TOGGLE_LINK_COMMAND, null));
    if (now?.url) return act(() => editor.dispatchCommand(TOGGLE_LINK_COMMAND, now.url!));
    editor.getEditorState().read(() => {
      const s = $getSelection();
      saved.current = $isRangeSelection(s) ? s.clone() : null;
    });
    setUrl('');
    setLinkOpen(true);
  }, [act, editor]);

  const closeLink = () => {
    setLinkOpen(false);
    editor.focus();
  };

  const applyLink = () => {
    const t = url.trim();
    const href = asUrl(t) ?? (t ? `https://${t}` : undefined);
    setLinkOpen(false);
    if (!href) {
      editor.focus();
      return;
    }
    editor.focus(() =>
      editor.update(() => {
        if (!$isRangeSelection($getSelection()) && saved.current) $setSelection(saved.current.clone());
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return;
        if (selection.isCollapsed()) {
          // Nothing to wrap: the address itself becomes the link text.
          const node = $createLinkNode(href);
          node.append($createTextNode(href));
          selection.insertNodes([node]);
        } else {
          editor.dispatchCommand(TOGGLE_LINK_COMMAND, href);
        }
      }),
    );
  };

  useEffect(
    () =>
      editor.registerCommand(
        KEY_DOWN_COMMAND,
        (e) => {
          if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'k' || isDisabled) return false;
          e.preventDefault();
          link();
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    [editor, link, isDisabled],
  );

  const has = (f: TextFormatType) => cur?.formats.has(f) ?? false;
  const is = (b: Block) => cur?.block === b;

  return (
    // Swallowing the press keeps focus, and so the selection, in the editor; click still fires.
    <div ref={bar} className="cf-rt-toolbar" role="toolbar" aria-label="Formatting" onMouseDown={(e) => e.preventDefault()}>
      <div className="cf-rt-group" role="group" aria-label="Text">
        <ToggleButton
          label="Bold"
          tooltip={`Bold (${MOD}B)`}
          size="sm"
          isIconOnly
          icon={<b className="cf-rt-glyph">B</b>}
          isPressed={has('bold')}
          onPressedChange={() => format('bold')}
          isDisabled={isDisabled}
        />
        <ToggleButton
          label="Italic"
          tooltip={`Italic (${MOD}I)`}
          size="sm"
          isIconOnly
          icon={<i className="cf-rt-glyph">I</i>}
          isPressed={has('italic')}
          onPressedChange={() => format('italic')}
          isDisabled={isDisabled}
        />
        <ToggleButton
          label="Strikethrough"
          size="sm"
          isIconOnly
          icon={<s className="cf-rt-glyph">S</s>}
          isPressed={has('strikethrough')}
          onPressedChange={() => format('strikethrough')}
          isDisabled={isDisabled}
        />
        <ToggleButton
          label="Code"
          size="sm"
          isIconOnly
          icon={<Code size={16} weight="regular" />}
          isPressed={has('code')}
          onPressedChange={() => format('code')}
          isDisabled={isDisabled}
        />
      </div>
      <span className="cf-rt-sep" aria-hidden="true" />
      <div className="cf-rt-group" role="group" aria-label="Link">
        <ToggleButton
          label={cur?.link ? 'Remove link' : 'Link'}
          tooltip={cur?.link ? 'Remove link' : `Link (${MOD}K)`}
          size="sm"
          isIconOnly
          icon={<LinkSimple size={16} weight="regular" />}
          isPressed={cur?.link ?? false}
          onPressedChange={link}
          isDisabled={isDisabled}
        />
        <Popover
          anchorRef={bar}
          isOpen={linkOpen}
          onOpenChange={(open) => (open ? setLinkOpen(true) : closeLink())}
          label="Link address"
          placement="below"
          alignment="start"
          width={300}
          padding={2}
          content={
            <form
              className="cf-rt-linkform"
              onSubmit={(e) => {
                e.preventDefault();
                applyLink();
              }}
            >
              <HStack gap={2} align="center">
                <StackItem size="fill">
                  <TextInput label="Address" isLabelHidden size="sm" value={url} onChange={setUrl} hasAutoFocus width="100%" />
                </StackItem>
                <Button label="Link" size="sm" variant="primary" type="submit" isDisabled={!url.trim()} />
              </HStack>
            </form>
          }
        />
      </div>
      <span className="cf-rt-sep" aria-hidden="true" />
      <div className="cf-rt-group" role="group" aria-label="Block">
        <ToggleButton
          label="Bulleted list"
          size="sm"
          isIconOnly
          icon={<ListBullets size={16} weight="regular" />}
          isPressed={is('bullet')}
          onPressedChange={() => list('bullet')}
          isDisabled={isDisabled}
        />
        <ToggleButton
          label="Numbered list"
          size="sm"
          isIconOnly
          icon={<ListNumbers size={16} weight="regular" />}
          isPressed={is('number')}
          onPressedChange={() => list('number')}
          isDisabled={isDisabled}
        />
        <ToggleButton
          label="Checklist"
          size="sm"
          isIconOnly
          icon={<ListChecks size={16} weight="regular" />}
          isPressed={is('check')}
          onPressedChange={() => list('check')}
          isDisabled={isDisabled}
        />
        <ToggleButton
          label="Quote"
          size="sm"
          isIconOnly
          icon={<Quotes size={16} weight="regular" />}
          isPressed={is('quote')}
          onPressedChange={() => block('quote')}
          isDisabled={isDisabled}
        />
        <ToggleButton
          label="Code block"
          size="sm"
          isIconOnly
          icon={<CodeBlock size={16} weight="regular" />}
          isPressed={is('code')}
          onPressedChange={() => block('code')}
          isDisabled={isDisabled}
        />
      </div>
    </div>
  );
}
