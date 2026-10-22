import type { ReactNode } from 'react';
import type { SearchHit } from '../../shared/types';

/**
 * 编辑器底部的「🧠 相关笔记」（0.12.0 阶段3）。
 *
 * 只是展示层：数据由 Knowledge 页面通过 api.relatedNotes 拉取（主进程用 FTS5 关键词匹配，
 * 且 SQL 里 `and n.id != ?` 保证不会把当前笔记推荐给自己）。
 * 面板是正常文档流里的一块（不是浮层），编辑器正文用 flex:1 自动让位，不会盖住工具栏/正文。
 */
export default function RelatedNotes(props: {
  items: SearchHit[];
  loading: boolean;
  onOpen: (id: number) => void;
}): ReactNode {
  return (
    <section className="related-notes" aria-label="相关笔记">
      <div className="related-notes-head">
        <span className="related-notes-title">🧠 相关笔记</span>
        <span className="spacer" style={{ flex: 1 }} />
        <span className="related-notes-status">
          {props.loading ? '正在按正文关键词找…' : '按正文关键词匹配'}
        </span>
      </div>
      {props.items.length > 0 ? (
        <div className="related-notes-list">
          {props.items.map((hit) => (
            <button
              key={hit.note_id}
              type="button"
              className="related-note"
              data-note-id={hit.note_id}
              title={'打开：' + hit.title}
              onClick={() => props.onOpen(hit.note_id)}
            >
              <span className="related-note-title">{hit.title || '无标题笔记'}</span>
              <span className="related-note-sub">
                {hit.category_name ? hit.category_name + ' · ' : ''}
                {hit.snippet.replace(/[\u0000-\u001f]/g, ' ')}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="related-notes-empty">
          {props.loading ? '正在根据正文关键词找相关笔记…' : '还没有找到相关笔记，写点更具体的内容再试试'}
        </div>
      )}
    </section>
  );
}
