// Comments on an action or artefact, threaded one level deep: a reply sits
// under the comment it answers. Anyone signed in can comment at any status;
// agents read the same thread when they next pick the work up. Links go in
// the Markdown; files come from the editor's attach button, a paste or a
// drop, and upload straight away so the comment only carries pointers.

import { Button } from '@astryxdesign/core/Button';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { Token } from '@astryxdesign/core/Token';
import { isBlank, type Attachment, type Comment } from '@lamproom/core';
import { useEffect, useState } from 'react';
import { Icon, cx } from '../graph/nodes';
import { RichTextEditor } from '../rich/RichTextEditor';
import { RichTextView } from '../rich/RichTextView';
import type { Run, Upload } from './Panel';

const who = (c: Comment) => (c.by.name ?? c.by.id) + (c.via ? ` via ${c.via.name ?? c.via.id}` : '');
const when = (ts: string) => new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const bytes = (n?: number) =>
  n === undefined ? undefined : n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
const isImage = (a: Attachment) => /^image\/(png|jpeg|gif|webp)$/.test(a.type ?? '');

function AttachmentView({ a }: { a: Attachment }) {
  const name = a.title ?? a.ref;
  if (isImage(a)) {
    return (
      <a className="lr-attachment-image" href={a.ref} target="_blank" rel="noreferrer" title={name}>
        <img src={a.ref} alt={name} loading="lazy" />
      </a>
    );
  }
  return (
    <a className="lr-attachment" href={a.ref} target="_blank" rel="noreferrer" title={a.ref}>
      <Icon name="file" size={12} /> {name}
      {a.size !== undefined && <span className="lr-attachment-size">{bytes(a.size)}</span>}
    </a>
  );
}

function One({ c, onReply }: { c: Comment; onReply?: () => void }) {
  return (
    <li className={cx('lr-comment', c.by.kind === 'agent' && 'is-agent')}>
      <div className="lr-comment-meta">
        <Text weight="semibold" size="sm">
          {who(c)}
        </Text>
        <Text type="supporting" size="sm">
          {when(c.ts)}
        </Text>
        <span className="lr-spacer" />
        {onReply && <Button label="Reply" variant="ghost" size="sm" onClick={onReply} />}
      </div>
      {!isBlank(c.body) && <RichTextView value={c.body} />}
      {c.attachments?.length ? (
        <div className="lr-attachments">
          {c.attachments.map((a, i) => (
            <AttachmentView key={i} a={a} />
          ))}
        </div>
      ) : null}
    </li>
  );
}

export function Comments({
  targetId,
  comments,
  canAct,
  run,
  upload,
}: {
  targetId: string;
  comments: Comment[];
  canAct: boolean;
  run: Run;
  upload: Upload;
}) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string>();
  const [replyTo, setReplyTo] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setText('');
    setFiles([]);
    setError(undefined);
    setReplyTo(undefined);
  }, [targetId]);

  const ids = new Set(comments.map((c) => c.id));
  // A reply to a reply joins the top comment's thread.
  const root = (c: Comment): string => {
    let cur = c;
    const seen = new Set<string>();
    while (cur.replyTo && ids.has(cur.replyTo) && !seen.has(cur.id)) {
      seen.add(cur.id);
      cur = comments.find((x) => x.id === cur.replyTo)!;
    }
    return cur.id;
  };
  const tops = comments.filter((c) => !c.replyTo || !ids.has(c.replyTo));
  const replies = (id: string) => comments.filter((c) => c.id !== id && root(c) === id);

  const attach = (picked: File[]) => {
    setError(undefined);
    for (const f of picked) {
      setUploading((n) => n + 1);
      upload(f)
        .then((a) => setFiles((prev) => [...prev, a]))
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setUploading((n) => n - 1));
    }
  };

  const canPost = canAct && !busy && !uploading && (!isBlank(text) || files.length > 0);
  const post = async () => {
    if (!canPost) return;
    setBusy(true);
    try {
      await run('comment', { targetId, body: text, attachments: files.length ? files : undefined, replyTo });
      setText('');
      setFiles([]);
      setReplyTo(undefined);
    } finally {
      setBusy(false);
    }
  };
  const replying = replyTo ? comments.find((c) => c.id === replyTo) : undefined;

  return (
    <>
      {comments.length ? (
        <ol className="lr-comments">
          {tops.map((c) => (
            <li key={c.id} className="lr-thread">
              <ol className="lr-comments">
                <One c={c} onReply={canAct ? () => setReplyTo(c.id) : undefined} />
                {replies(c.id).map((r) => (
                  <One key={r.id} c={r} onReply={canAct ? () => setReplyTo(r.id) : undefined} />
                ))}
              </ol>
            </li>
          ))}
        </ol>
      ) : (
        <Text as="p" type="supporting">
          No comments yet. Anything said here reaches the next agent to pick this up.
        </Text>
      )}
      {canAct && (
        <>
          {replying && (
            <HStack gap={2} align="center">
              <Text type="supporting" size="sm">
                Replying to {who(replying)}
              </Text>
              <Button label="Cancel" variant="ghost" size="sm" onClick={() => setReplyTo(undefined)} />
            </HStack>
          )}
          <RichTextEditor
            label="Comment"
            isLabelHidden
            value={text}
            onChange={setText}
            rows={3}
            isDisabled={busy}
            onSubmit={canPost ? post : undefined}
            onFiles={attach}
            width="100%"
          />
          {(files.length > 0 || uploading > 0 || error) && (
            <div className="lr-attachments">
              {files.map((f, i) => (
                <Token
                  key={f.ref}
                  size="sm"
                  color="gray"
                  label={f.title ?? f.ref}
                  description={bytes(f.size)}
                  icon={<Icon name={isImage(f) ? 'image' : 'file'} size={12} />}
                  onRemove={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                />
              ))}
              {uploading > 0 && (
                <Text type="supporting" size="sm">
                  Uploading {uploading} file{uploading === 1 ? '' : 's'}…
                </Text>
              )}
              {error && (
                <span className="lr-attachment-error">
                  <Text size="sm" color="inherit">
                    {error}
                  </Text>
                </span>
              )}
            </div>
          )}
          <HStack gap={2} justify="end">
            <Button label={replying ? 'Reply' : 'Comment'} variant="primary" size="sm" isDisabled={!canPost} clickAction={post} />
          </HStack>
        </>
      )}
    </>
  );
}
