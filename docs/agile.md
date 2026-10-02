# Agile planning

Any project can plan its work in sprints. Turn on **Agile** in the project's settings (**Admin > Projects > your project**), choose it in the setup guide, or install the **Agile Software Team** template. Every other project is unaffected.

Staff open it from **Planning** in the top bar. It has three views.

## Backlog

- **The backlog** is one ranked list per project. Drag items to rank them; the order is shared by the whole team. With an item focused, **Alt+↑** and **Alt+↓** move it.
- **Sprints** sit above the backlog. Drag items into a sprint to plan them, or use each row's sprint menu. Each sprint shows its item count and points, and warns when a planned sprint holds more than the team usually finishes.
- **Story points** are edited in place on each row, the record page or the new-record form. Up to one decimal place: 0.5, 1, 2, 3, 5, 8, 13…
- **Epics** are records of an epic type (a record type marked **Epic type** on the project admin page). The panel on the left lists them with their progress; click one to show only its work, or add a new one. Choose an item's epic on its record page or when creating it. Epics are not planned into sprints themselves: plan their stories.
- **Add** at the foot of the backlog creates an item in one line. Types with required questions use **New record** instead.

### The sprint cycle

1. **Create sprint** adds a planned sprint (named "APP Sprint 1", "APP Sprint 2"…, rename it with **Edit**).
2. **Start sprint**: set a goal, a start date and a length of one to four weeks. Only one sprint runs at a time. Starting records the commitment: the points and items in the sprint.
3. Work moves across the **sprint board**.
4. **Complete sprint** records what was done and moves anything unfinished to a planned sprint, a new sprint, or the backlog. Each moved item's history says so.

A running sprint keeps its start date (change its end date if it needs more time). Finished work stays with the sprint it was finished in; reopening it later puts it back in the backlog.

## Sprint board

The running sprint's items in one column per status (every status the project's non-epic types use, in workflow order), ranked as in the backlog.

- Drag a card to another column to run the transition that leads there, exactly as in the records board. Approvals and required fields apply.
- **Swimlanes** group the board by epic, assignee (yours first) or priority, with counts and points per lane and per column. Lanes collapse.
- **Only my work** filters to your items.

## Reports

- **Burndown** for the running sprint or any completed one: points remaining each day against the ideal line, with committed, done, remaining and scope change (points added or re-estimated since the start). Every chart has a table view.
- **Velocity**: committed and completed points for the last eight completed sprints, with the average of the last three as a guide for the next sprint.
- **Epic progress**: done versus total, by points (or by count where there are no points).

The burndown is drawn from a daily snapshot that is rewritten whenever something that moves the line changes: a status category, story points, sprint membership, deletion or restore, or a workflow change that remaps statuses. Days without a change carry the previous day forward.

## Who can do what

- Admins and agents plan, start and complete sprints and rank the backlog. Requesters never see planning; story points and epics they send are ignored.
- In a **restricted** project, planning is visible only to admins and members of the project's default team.
- An item's epic title shows only to people who could open the epic.

## API

All under `/api`, for signed-in staff or tokens (reading needs `records:read`, changes need `records:write`):

```http
GET    /projects/:id/backlog        → { project, sprints: [sprint + records], backlog, epics }
GET    /projects/:id/sprints        → { sprints }
POST   /projects/:id/sprints        { name?, goal? } → 201 { sprint }
GET    /projects/:id/velocity       → { sprints: [{ name, committed, completed }], average }
PATCH  /sprints/:id                 { name?, goal?, startAt?, endAt? }   (planned sprints; a running one may change name, goal and end)
DELETE /sprints/:id                 (planned sprints; their work returns to the backlog)
POST   /sprints/:id/start           { goal?, startAt?, weeks? (1–8, default 2), endAt? }
POST   /sprints/:id/complete        { moveTo: plannedSprintId | null } → { sprint, moved }
GET    /sprints/:id/report          → { sprint, days: [{ date, ideal, remaining, scope }], scopeChange }
POST   /records/:key/plan           { sprintId?: id | null, afterId?, beforeId? } → { record }
```

Records carry `storyPoints`, `sprintId`, `epicId`, `epicKey`, `epicTitle` and `rank`; set `storyPoints` and `epicId` on create or with `PATCH /records/:key`. Filter lists and boards with `sprintId=active|backlog|<id>` and `epicId=none|<id>`, sort with `sort=rank_asc`, and draw a project's status board with `GET /board?projectId=…&columns=status`. Webhook endpoints can subscribe to `sprint.started` and `sprint.completed`.
