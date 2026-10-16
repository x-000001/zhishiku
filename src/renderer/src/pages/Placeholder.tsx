import type { ReactNode } from 'react';

export default function Placeholder(props: {
  icon: string;
  title: string;
  hint: string;
  note?: string;
}): ReactNode {
  return (
    <div className="card" style={{ textAlign: 'center', padding: '46px 20px' }}>
      <div style={{ fontSize: 40, marginBottom: 10 }}>{props.icon}</div>
      <h2 style={{ margin: '0 0 8px', fontSize: 17 }}>{props.title}</h2>
      <p className="muted" style={{ maxWidth: 460, margin: '0 auto', lineHeight: 1.8 }}>
        {props.hint}
      </p>
      {props.note ? (
        <p className="muted" style={{ marginTop: 14 }}>
          {props.note}
        </p>
      ) : null}
    </div>
  );
}
