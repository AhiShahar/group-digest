// Decisions shown as small cards: what was decided, then who, when and where.
import { decisionWhen } from './lib/decisions';
import type { Decision } from './lib/digest';

export interface DecisionRow {
  d: Decision;
  group?: string;
  onOpenGroup?: () => void;
}

export function DecisionCards({ rows }: { rows: DecisionRow[] }) {
  if (!rows.length) return null;
  return (
    <ul className="decisions">
      {rows.map(({ d, group, onOpenGroup }, i) => {
        const when = decisionWhen(d);
        return (
          <li key={i}>
            <p className="what" dir="auto">
              {d.what}
            </p>
            {(d.who || when || d.where || group) && (
              <dl className="facts">
                {d.who && (
                  <>
                    <dt>Who</dt>
                    <dd dir="auto">{d.who}</dd>
                  </>
                )}
                {when && (
                  <>
                    <dt>When</dt>
                    <dd>{when}</dd>
                  </>
                )}
                {d.where && (
                  <>
                    <dt>Where</dt>
                    <dd dir="auto">{d.where}</dd>
                  </>
                )}
                {group && (
                  <>
                    <dt>Group</dt>
                    <dd dir="auto">
                      {onOpenGroup ? (
                        <button className="link inline" onClick={onOpenGroup}>
                          {group}
                        </button>
                      ) : (
                        group
                      )}
                    </dd>
                  </>
                )}
              </dl>
            )}
          </li>
        );
      })}
    </ul>
  );
}
