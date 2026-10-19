// A rich text editor over the RichText primitive (Markdown): the Boxops
// Lexical editor rebuilt on Astryx, with a toolbar always showing at the top
// of the frame. Typing Markdown works too: `- `, `1. `, `# `, `> `, ``` and
// **bold** become structure as you type, typed addresses become links, and a
// link pasted over a selection links it. Cmd or Ctrl+Enter submits where a
// form wants it.

import { Field } from '@astryxdesign/core/Field';
import type { RichText } from '@coalface/core';
import { CodeHighlightNode, CodeNode } from '@lexical/code';
import { AutoLinkNode, LinkNode } from '@lexical/link';
import { ListItemNode, ListNode } from '@lexical/list';
import { $convertFromMarkdownString, $convertToMarkdownString, TRANSFORMERS } from '@lexical/markdown';
import { AutoFocusPlugin } from '@lexical/react/LexicalAutoFocusPlugin';
import { AutoLinkPlugin } from '@lexical/react/LexicalAutoLinkPlugin';
import { CheckListPlugin } from '@lexical/react/LexicalCheckListPlugin';
import { LexicalComposer, type InitialConfigType } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { LinkPlugin } from '@lexical/react/LexicalLinkPlugin';
import { ListPlugin } from '@lexical/react/LexicalListPlugin';
import { MarkdownShortcutPlugin } from '@lexical/react/LexicalMarkdownShortcutPlugin';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { $createParagraphNode, $getRoot, COMMAND_PRIORITY_HIGH, KEY_ENTER_COMMAND } from 'lexical';
import { useEffect, useId, useRef, type CSSProperties } from 'react';
import { cx } from '../graph/nodes';
import { Toolbar } from './Toolbar';

const THEME = {
  paragraph: 'cf-rt-p',
  heading: { h1: 'cf-rt-h1', h2: 'cf-rt-h2', h3: 'cf-rt-h3', h4: 'cf-rt-h4', h5: 'cf-rt-h5', h6: 'cf-rt-h6' },
  quote: 'cf-rt-quote',
  list: {
    ul: 'cf-rt-ul',
    ol: 'cf-rt-ol',
    listitem: 'cf-rt-li',
    nested: { listitem: 'cf-rt-li-nested' },
    listitemChecked: 'cf-rt-li-checked',
    listitemUnchecked: 'cf-rt-li-unchecked',
    checklist: 'cf-rt-checklist',
  },
  code: 'cf-rt-code',
  link: 'cf-rt-link',
  text: {
    bold: 'cf-rt-bold',
    italic: 'cf-rt-italic',
    strikethrough: 'cf-rt-strike',
    code: 'cf-rt-icode',
    underline: 'cf-rt-underline',
    highlight: 'cf-rt-highlight',
  },
};

const NODES = [HeadingNode, QuoteNode, ListNode, ListItemNode, LinkNode, AutoLinkNode, CodeNode, CodeHighlightNode];

const isUrl = (u: string) => /^(https?:\/\/|mailto:)\S+$/i.test(u);

const URL_MATCHERS = [
  (text: string) => {
    const m = /((?:https?:\/\/|www\.)[^\s<]+[^\s<.,:;"')\]])/i.exec(text);
    if (!m) return null;
    const url = m[0];
    return { index: m.index, length: url.length, text: url, url: /^www\./i.test(url) ? `https://${url}` : url };
  },
];

/** Keeps the editor and the Markdown value in step without echoing either side's writes. */
function MarkdownSync({ value, onChange }: { value: RichText; onChange: (md: RichText) => void }) {
  const [editor] = useLexicalComposerContext();
  const last = useRef(value);
  useEffect(() => {
    if (value === last.current) return;
    last.current = value;
    editor.update(
      () => {
        $convertFromMarkdownString(value, TRANSFORMERS);
        if ($getRoot().isEmpty()) $getRoot().append($createParagraphNode());
      },
      { tag: 'cf-external' },
    );
  }, [editor, value]);
  useEffect(
    () =>
      editor.registerUpdateListener(({ editorState, dirtyElements, dirtyLeaves, tags }) => {
        if (tags.has('cf-external') || (dirtyElements.size === 0 && dirtyLeaves.size === 0)) return;
        const md = editorState.read(() => $convertToMarkdownString(TRANSFORMERS));
        if (md === last.current) return;
        last.current = md;
        onChange(md);
      }),
    [editor, onChange],
  );
  return null;
}

function SubmitPlugin({ onSubmit }: { onSubmit?: () => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    if (!onSubmit) return;
    return editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        if (!event || !(event.metaKey || event.ctrlKey)) return false;
        event.preventDefault();
        onSubmit();
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, onSubmit]);
  return null;
}

function EditablePlugin({ isEditable }: { isEditable: boolean }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => editor.setEditable(isEditable), [editor, isEditable]);
  return null;
}

export interface RichTextEditorProps {
  label: string;
  value: RichText;
  onChange: (value: RichText) => void;
  isLabelHidden?: boolean;
  description?: string;
  placeholder?: string;
  /** Minimum height, in lines. */
  rows?: number;
  isOptional?: boolean;
  isRequired?: boolean;
  isDisabled?: boolean;
  hasAutoFocus?: boolean;
  /** Cmd or Ctrl+Enter. */
  onSubmit?: () => void;
  width?: number | string;
}

export function RichTextEditor({
  label,
  value,
  onChange,
  isLabelHidden,
  description,
  placeholder,
  rows = 3,
  isOptional,
  isRequired,
  isDisabled = false,
  hasAutoFocus,
  onSubmit,
  width,
}: RichTextEditorProps) {
  const id = useId();
  const initial = useRef(value);
  const initialConfig: InitialConfigType = {
    namespace: 'coalface',
    theme: THEME,
    nodes: NODES,
    editable: !isDisabled,
    onError: (e) => console.error('rich text editor', e),
    editorState: () => {
      $convertFromMarkdownString(initial.current, TRANSFORMERS);
      if ($getRoot().isEmpty()) $getRoot().append($createParagraphNode());
    },
  };
  return (
    <Field
      label={label}
      inputID={id}
      isLabelHidden={isLabelHidden}
      description={description}
      isOptional={isOptional}
      isRequired={isRequired}
      isDisabled={isDisabled}
      width={width}
    >
      <div className={cx('cf-rt', isDisabled && 'is-disabled')} style={{ '--cf-rt-rows': rows } as CSSProperties}>
        <LexicalComposer initialConfig={initialConfig}>
          <Toolbar isDisabled={isDisabled} />
          <div className="cf-rt-body">
            <RichTextPlugin
              contentEditable={
                <ContentEditable
                  id={id}
                  className="cf-rt-editor"
                  aria-placeholder={placeholder ?? ''}
                  placeholder={<div className="cf-rt-placeholder">{placeholder ?? ''}</div>}
                />
              }
              ErrorBoundary={LexicalErrorBoundary}
            />
          </div>
          <HistoryPlugin />
          <ListPlugin />
          <CheckListPlugin />
          <LinkPlugin validateUrl={isUrl} />
          <AutoLinkPlugin matchers={URL_MATCHERS} />
          <MarkdownShortcutPlugin transformers={TRANSFORMERS} />
          {hasAutoFocus && <AutoFocusPlugin />}
          <MarkdownSync value={value} onChange={onChange} />
          <SubmitPlugin onSubmit={onSubmit} />
          <EditablePlugin isEditable={!isDisabled} />
        </LexicalComposer>
      </div>
    </Field>
  );
}
