import { forwardRef, useImperativeHandle, useState } from "react";
import { useEditor, useEditorState, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import TextAlign from "@tiptap/extension-text-align";
import Image from "@tiptap/extension-image";
import {
  TextBIcon, TextItalicIcon, TextUnderlineIcon, TextStrikethroughIcon,
  ListBulletsIcon, ListNumbersIcon, TextAlignLeftIcon, TextAlignCenterIcon,
  TextAlignRightIcon, TextAlignJustifyIcon, CodeIcon, CodeBlockIcon, QuotesIcon,
  MinusIcon, LinkIcon, LinkBreakIcon, ImageIcon, ArrowCounterClockwiseIcon,
  ArrowClockwiseIcon, ArrowsOutSimpleIcon, EraserIcon,
} from "@phosphor-icons/react";

export interface RichTextHandle {
  setHtml: (html: string) => void;
  getHtml: () => string;
  focus: () => void;
}

interface Props {
  initialHtml?: string;
  placeholder?: string;
  minHeight?: number;
  onChange?: (html: string) => void;
}

const HEADINGS = [
  { label: "Paragraph", level: 0 },
  { label: "Heading 1", level: 1 },
  { label: "Heading 2", level: 2 },
  { label: "Heading 3", level: 3 },
  { label: "Heading 4", level: 4 },
] as const;

// Full-featured TipTap editor matching the Topup Arena toolbar: headings,
// bold/italic/underline/strike, lists, alignment, code, code-block, blockquote,
// horizontal rule, link/unlink, image, clear-formatting, undo/redo, fullscreen.
export const RichText = forwardRef<RichTextHandle, Props>(function RichText(
  { initialHtml = "", placeholder = "Write…", minHeight = 140, onChange },
  ref
) {
  const [full, setFull] = useState(false);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false } }),
      Placeholder.configure({ placeholder }),
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      Image.configure({ inline: false, allowBase64: true }),
    ],
    content: initialHtml,
    onUpdate: ({ editor }) => onChange?.(editor.getHTML()),
  });

  useImperativeHandle(
    ref,
    () => ({
      setHtml: (html: string) => { editor?.commands.setContent(html); onChange?.(html); },
      getHtml: () => editor?.getHTML() ?? "",
      focus: () => editor?.commands.focus(),
    }),
    [editor, onChange]
  );

  const st = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e?.isActive("bold") ?? false,
      italic: e?.isActive("italic") ?? false,
      underline: e?.isActive("underline") ?? false,
      strike: e?.isActive("strike") ?? false,
      bullet: e?.isActive("bulletList") ?? false,
      ordered: e?.isActive("orderedList") ?? false,
      code: e?.isActive("code") ?? false,
      codeBlock: e?.isActive("codeBlock") ?? false,
      quote: e?.isActive("blockquote") ?? false,
      link: e?.isActive("link") ?? false,
      left: e?.isActive({ textAlign: "left" }) ?? false,
      center: e?.isActive({ textAlign: "center" }) ?? false,
      right: e?.isActive({ textAlign: "right" }) ?? false,
      justify: e?.isActive({ textAlign: "justify" }) ?? false,
      heading: e?.getAttributes("heading")?.level ?? 0,
      isHeading: e?.isActive("heading") ?? false,
    }),
  });

  if (!editor) return <div className="richtext" style={{ minHeight }} />;
  const chain = () => editor.chain().focus();

  const setHeading = (level: number) => {
    if (level === 0) chain().setParagraph().run();
    else chain().toggleHeading({ level: level as 1 | 2 | 3 | 4 }).run();
  };
  const setLink = () => {
    if (st?.link) { chain().unsetLink().run(); return; }
    const url = window.prompt("Link URL");
    if (url) chain().setLink({ href: url }).run();
  };
  const addImage = () => {
    const url = window.prompt("Image URL");
    if (url) chain().setImage({ src: url }).run();
  };

  const B = ({ on, title, run, children }: { on?: boolean; title: string; run: () => void; children: React.ReactNode }) => (
    <button type="button" className={`rt-btn${on ? " on" : ""}`} title={title} onMouseDown={(e) => e.preventDefault()} onClick={run}>{children}</button>
  );
  const Sep = () => <span className="rt-sep" />;

  return (
    <div className={`richtext${full ? " rt-full" : ""}`}>
      <div className="rt-toolbar">
        <select
          className="rt-select"
          value={st?.isHeading ? st.heading : 0}
          onChange={(e) => setHeading(Number(e.target.value))}
        >
          {HEADINGS.map((h) => <option key={h.level} value={h.level}>{h.label}</option>)}
        </select>
        <Sep />
        <B on={st?.bold} title="Bold" run={() => chain().toggleBold().run()}><TextBIcon size={15} /></B>
        <B on={st?.italic} title="Italic" run={() => chain().toggleItalic().run()}><TextItalicIcon size={15} /></B>
        <B on={st?.underline} title="Underline" run={() => chain().toggleUnderline().run()}><TextUnderlineIcon size={15} /></B>
        <B on={st?.strike} title="Strikethrough" run={() => chain().toggleStrike().run()}><TextStrikethroughIcon size={15} /></B>
        <Sep />
        <B on={st?.bullet} title="Bulleted list" run={() => chain().toggleBulletList().run()}><ListBulletsIcon size={15} /></B>
        <B on={st?.ordered} title="Numbered list" run={() => chain().toggleOrderedList().run()}><ListNumbersIcon size={15} /></B>
        <Sep />
        <B on={st?.left} title="Align left" run={() => chain().setTextAlign("left").run()}><TextAlignLeftIcon size={15} /></B>
        <B on={st?.center} title="Align center" run={() => chain().setTextAlign("center").run()}><TextAlignCenterIcon size={15} /></B>
        <B on={st?.right} title="Align right" run={() => chain().setTextAlign("right").run()}><TextAlignRightIcon size={15} /></B>
        <B on={st?.justify} title="Justify" run={() => chain().setTextAlign("justify").run()}><TextAlignJustifyIcon size={15} /></B>
        <Sep />
        <B on={st?.code} title="Inline code" run={() => chain().toggleCode().run()}><CodeIcon size={15} /></B>
        <B on={st?.codeBlock} title="Code block" run={() => chain().toggleCodeBlock().run()}><CodeBlockIcon size={15} /></B>
        <B on={st?.quote} title="Quote" run={() => chain().toggleBlockquote().run()}><QuotesIcon size={15} /></B>
        <B title="Divider" run={() => chain().setHorizontalRule().run()}><MinusIcon size={15} /></B>
        <Sep />
        <B on={st?.link} title="Link" run={setLink}><LinkIcon size={15} /></B>
        <B title="Remove link" run={() => chain().unsetLink().run()}><LinkBreakIcon size={15} /></B>
        <B title="Insert image" run={addImage}><ImageIcon size={15} /></B>
        <B title="Clear formatting" run={() => chain().unsetAllMarks().clearNodes().run()}><EraserIcon size={15} /></B>
        <Sep />
        <B title="Undo" run={() => chain().undo().run()}><ArrowCounterClockwiseIcon size={15} /></B>
        <B title="Redo" run={() => chain().redo().run()}><ArrowClockwiseIcon size={15} /></B>
        <span className="rt-grow" />
        <B title="Fullscreen" run={() => setFull((v) => !v)}><ArrowsOutSimpleIcon size={15} /></B>
      </div>
      <EditorContent editor={editor} className="rt-area" style={{ minHeight }} />
    </div>
  );
});
