import { t } from 'elysia';
export const exactTime = t.Object({
  ticks: t.String({ pattern: '^-?(0|[1-9][0-9]{0,38})$' }),
  timescale: t.Integer({ minimum: 1, maximum: 4294967295 }),
});
export const presentationRange = t.Object({ start: exactTime, end: exactTime });
export const trackSelection = t.Optional(
  t.Object({ inputId: t.String(), trackId: t.Integer({ minimum: 0 }) }),
);
export const timelineOptions = t.Optional(
  t.Object({
    range: t.Optional(presentationRange),
    gapPolicy: t.Optional(t.Union([t.Literal('preserve'), t.Literal('collapse')])),
    changePolicy: t.Optional(t.Union([t.Literal('fail'), t.Literal('split')])),
    epochAnchors: t.Optional(
      t.Array(
        t.Object({
          inputId: t.Union([t.Literal('primary'), t.Literal('audio')]),
          epoch: t.String({ pattern: '^[0-9]+$' }),
          source: exactTime,
          presentation: exactTime,
        }),
      ),
    ),
    limits: t.Optional(
      t.Object({
        samples: t.Optional(t.Integer({ minimum: 1 })),
        resources: t.Optional(t.Integer({ minimum: 1 })),
      }),
    ),
    tailDuration: t.Optional(exactTime),
  }),
);
