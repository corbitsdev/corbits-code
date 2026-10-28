import type { ToolDefinition } from "@intx/types/runtime";

// Names, descriptions, and top-level parameter schemas copied from the live
// Linear MCP server (26 of its 83 tools), so ranking tests compete against
// the descriptions and filter parameters a real session sees.

const PAGE = {
  cursor:
    "Omit for the first page. To continue, pass the previous response's cursor when hasNextPage is true",
  limit: "Maximum number of results to return per page",
  orderBy: "Timestamp to sort results by: creation time or last update time",
  createdAt: "Created after: ISO-8601 date/duration (e.g., -P1D)",
  updatedAt: "Updated after: ISO-8601 date/duration (e.g., -P1D)",
  includeArchived: "Include archived items",
};
const FIELDS =
  "Fields to include in each result. Explicitly requested fields with no value return null. `id` is always included. Omit or pass an empty array for the default response.";
const PATCH =
  "Partial edits applied to the current content, in order and atomically (one failing operation aborts the whole save). Every anchor string must match the current content exactly once. Only valid on update, in place of the full content/description field";

function def(
  name: string,
  description: string,
  props: Record<string, string>,
): ToolDefinition {
  return {
    name: `mcp__linear__${name}`,
    description: `[linear] ${description}`,
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(props).map(([k, d]) => [
          k,
          { type: "string", description: d },
        ]),
      ),
    },
  };
}

export const liveLinearCatalog: ToolDefinition[] = [
  def(
    "list_issues",
    `List issues in the user's Linear workspace, including active Triage Intelligence suggestions for issues in triage. For issues assigned to me, use "me" as the assignee. For issues created by me, use "me" as the creator. Use "null" for no assignee.`,
    {
      assignee: 'User ID, name, email, or "me"',
      createdAt: PAGE.createdAt,
      creator: 'User ID, name, email, or "me"',
      cursor: PAGE.cursor,
      customView:
        "Saved view ID, URL, slug, or exact name. Use list_custom_views to discover views. Applies saved filters and scope; other filters narrow the results. Uses list ordering, not saved display settings",
      cycle: "Cycle name, number, or ID",
      delegate:
        'Agent name or ID. When the user asks to delegate to "Linear" or "the Linear agent", this refers to the "Linear" app user specifically',
      fields: FIELDS,
      includeArchived: PAGE.includeArchived,
      includeSubTeams:
        "Include results from the selected team and all descendants when team is set. Team ID filters already include descendants; this also expands name and key filters",
      label: "Label name or ID",
      limit: PAGE.limit,
      orderBy: PAGE.orderBy,
      parentId: "Parent issue ID or identifier (e.g., LIN-123)",
      priority: "0=None, 1=Urgent, 2=High, 3=Medium, 4=Low",
      project: "Project name, ID, identifier (e.g., P-ENG-123), or slug",
      query:
        "Search issue title or description. Cannot be combined with customView",
      release: "Release ID or slug",
      state: "State type, name, or ID",
      team: "Team name or ID",
      triagedAt:
        'Left triage after: ISO-8601 date/duration (e.g., -P1D). Issues still in triage have no triagedAt; list them with state "triage"',
      updatedAt: PAGE.updatedAt,
    },
  ),
  def(
    "save_issue",
    'Create or update a Linear issue. If `id` is provided, updates the existing issue; otherwise creates a new one. When creating, `team` is required, and `title` is required unless `template` is set. Note: use `assignee` (not `assigneeId`) to set the assignee — it accepts a user ID, name, email, or "me".',
    {
      addLabels:
        'Label names or IDs as a JSON array of strings (e.g. ["Bug", "Urgent"]) to add. Append-only; existing labels are never removed. Cannot be combined with a team change',
      addReleases:
        "Release IDs or slugs to add. Append-only; existing releases are never removed",
      assignee: 'User ID, name, email, or "me". Null to remove',
      blockedBy:
        "Issue IDs/identifiers blocking this. Append-only; existing relations are never removed",
      blocks:
        "Issue IDs/identifiers this blocks. Append-only; existing relations are never removed",
      cycle: "Cycle name, number, or ID. Null to remove",
      delegate: "Agent name or ID. Null to remove",
      description:
        "Content as Markdown. Do not escape the string — use literal newlines and special characters, not escape sequences. To mention a user, use @displayName (e.g., @johndoe)",
      dueDate:
        "Due date (ISO format). On update, pass null to remove the due date",
      duplicateOf: "Duplicate of issue ID/identifier. Null to remove",
      estimate:
        "Issue estimate value. On create, pass null or omit for no estimate. On update, pass null to clear the estimate; omitting leaves it unchanged. 0 is a real estimate only on teams that allow zero estimates.",
      id: "Only for updating an existing issue. Pass the issue ID or identifier (e.g., LIN-123). Do NOT pass this parameter when creating a new issue.",
      labels:
        'Label names or IDs as a JSON array of strings (e.g. ["Bug", "Urgent"]). Replaces the full label set; existing labels not included are removed. Omit to leave labels unchanged. Cannot be combined with addLabels/removeLabels; prefer those for incremental changes',
      links:
        "Link attachments to add [{url, title}]. Append-only; existing links are never removed",
      milestone: "Milestone name or ID",
      parentId: "Parent issue ID or identifier (e.g., LIN-123). Null to remove",
      patch: PATCH,
      priority: "0=None, 1=Urgent, 2=High, 3=Medium, 4=Low",
      project:
        "Project name, ID, identifier (e.g., P-ENG-123), or slug. Null to remove",
      relatedTo:
        "Related issue IDs/identifiers. Append-only; existing relations are never removed",
      removeBlockedBy:
        "Issue IDs/identifiers to remove as blockers of this issue",
      removeBlocks: "Issue IDs/identifiers to stop blocking",
      removeLabels:
        'Label names or IDs as a JSON array of strings (e.g. ["Bug", "Urgent"]) to remove. Only valid when updating an existing issue. Cannot be combined with a team change',
      removeRelatedTo: "Related issue IDs/identifiers to remove",
      removeReleases:
        "Release IDs or slugs to remove. Only valid when updating an existing issue",
      setReleases:
        "Replace all releases on the issue with these. Cannot be combined with addReleases/removeReleases",
      slaBreachesAt:
        "ISO-8601 timestamp when the SLA will breach. On update, pass null to remove the SLA",
      slaType:
        'SLA day counting type: "all" or "onlyBusinessDays". Only use with slaBreachesAt; null means unset',
      state: "State type, name, or ID",
      team: "Team name or ID (required when creating)",
      template:
        "Template name or ID. Applied on create only. The template fills in the content, fields, and sub-issues server-side. A `description` replaces the template body rather than merging with it, but an empty `description` keeps the template body. Labels merge with the template's own",
      title: "Issue title (required when creating, unless template is set)",
    },
  ),
  def(
    "get_issue",
    "Retrieve detailed information about an issue by ID, including attachments, git branch name, and active Triage Intelligence suggestions when the issue is in triage. A nonempty fields selection overrides the include options; request optional fields directly in fields.",
    {
      fields: FIELDS,
      id: "Issue ID or identifier (e.g., LIN-123). P-prefixed identifiers (e.g., P-ENG-123) are projects, not issues",
      includeCustomerNeeds: "Include associated customer needs",
      includeRelations: "Include blocking/related/duplicate relations",
      includeReleases: "Include associated releases",
    },
  ),
  def("list_projects", "List projects in the user's Linear workspace", {
    createdAt: PAGE.createdAt,
    cursor: PAGE.cursor,
    customView:
      "Saved view ID, URL, slug, or exact name. Use list_custom_views to discover views. Applies saved filters and scope; other filters narrow the results. Uses list ordering, not saved display settings",
    fields: FIELDS,
    includeArchived: PAGE.includeArchived,
    includeMembers: "Include project members",
    includeMilestones: "Include milestones",
    includeSubTeams:
      "Include results from the selected team and all descendants when team is set. Team ID filters already include descendants; this also expands name and key filters",
    initiative: "Initiative name, ID, identifier (e.g., I-123), or slug",
    label: "Label name or ID",
    limit: "Max results (default 50, max 50)",
    member: 'User ID, name, email, or "me"',
    orderBy: PAGE.orderBy,
    query: "Search project name",
    state: "State type, name, or ID",
    team: "Team name or ID",
    updatedAt: PAGE.updatedAt,
  }),
  def(
    "save_project",
    "Create or update a Linear project. If `id` is provided, updates the existing project; otherwise creates a new one. When creating, `name` and at least one team (via `addTeams` or `setTeams`) are required. Pass `template` to create the project from a project template. To change parts of the description without resending all of it, pass `patch` instead of `description`. `state` resolves against the project statuses of the lead team, so pass `leadTeam` when creating a multi-team project whose teams use different statuses.",
    {
      addInitiatives:
        "Initiatives to add. Initiative name, ID, identifier (e.g., I-123), or slug",
      addTeams: "Team name or ID to add",
      color: "Hex color",
      description: "Content as Markdown.",
      icon: "Icon name or emoji code",
      id: "Project name, ID, identifier (e.g., P-ENG-123), or slug. If provided, updates the existing project",
      labels:
        'Label names or IDs as a JSON array of strings (e.g. ["Bug", "Urgent"]). Replaces the full label set; existing labels not included are removed. Omit to leave labels unchanged',
      lead: 'User ID, name, email, or "me". Null to remove, except on create with a template that names a lead',
      leadTeam:
        "Team that leads the project. Team name or ID. Overrides the default lead team; added to the project's teams when not among them",
      links:
        "External resource links to add [{url, title}]. Append-only; existing links are never removed",
      name: "Project name (required when creating)",
      patch: PATCH,
      priority: "0=None, 1=Urgent, 2=High, 3=Medium, 4=Low",
      removeInitiatives:
        "Initiatives to remove. Initiative name, ID, identifier (e.g., I-123), or slug",
      removeTeams: "Team name or ID to remove",
      setInitiatives: "Replace all initiatives with these.",
      setTeams: "Replace all teams with these.",
      startDate: "Start date (ISO format). Null to remove",
      state: "Project status name, type, or ID.",
      summary: "Short summary (max 255 chars)",
      targetDate: "Target date (ISO format). Null to remove",
      template: "Template name or ID. Applied on create only.",
    },
  ),
  def(
    "list_cycles",
    "List a team's cycles with their IDs, numbers, dates, and issue and scope histories",
    {
      teamId:
        "Team UUID from list_teams or get_team; names and keys are not accepted",
      type: "Filter relative to the team's current cycle. Omit to return cycles without this filter",
    },
  ),
  def(
    "list_issue_labels",
    "List available issue labels in a Linear workspace or team. A retired label carries `retiredAt` and cannot be applied to new issues.",
    {
      cursor: PAGE.cursor,
      includeArchived: PAGE.includeArchived,
      includeGroups:
        "Include label groups in the results, marked with `isGroup`.",
      limit: PAGE.limit,
      name: "Filter by name",
      orderBy: PAGE.orderBy,
      team: "Team name or ID",
    },
  ),
  def(
    "list_teams",
    "List teams in the user's Linear workspace, including their parent IDs and hierarchy names",
    {
      ancestorTeam:
        "All descendant teams of this team, at any depth, excluding itself (name, key, or ID)",
      createdAt: PAGE.createdAt,
      cursor: PAGE.cursor,
      includeArchived: PAGE.includeArchived,
      limit: PAGE.limit,
      orderBy: PAGE.orderBy,
      parentTeam: "Only direct sub-teams of this team (name, key, or ID)",
      query: "Search query",
      updatedAt: PAGE.updatedAt,
    },
  ),
  def(
    "list_users",
    "List workspace users with their IDs, names, emails, and admin, guest, and active flags. Use get_user for team memberships.",
    {
      cursor: PAGE.cursor,
      limit: PAGE.limit,
      orderBy: PAGE.orderBy,
      query:
        "Match part of a name or email. Omit to list users without a name or email filter",
      team: "Team name or ID. Only return members of this team; omit to search the workspace",
    },
  ),
  def("list_documents", "List documents in the user's Linear workspace", {
    createdAt: PAGE.createdAt,
    creatorId: "Filter by creator ID",
    cursor: PAGE.cursor,
    fields: FIELDS,
    includeArchived: PAGE.includeArchived,
    initiativeId:
      "Filter by initiative ID, identifier (e.g., 'I-123'), or slug",
    limit: PAGE.limit,
    orderBy: PAGE.orderBy,
    projectId: "Filter by project ID, identifier (e.g., 'P-ENG-123'), or slug",
    query: "Search query",
    teamId: "Filter by team ID",
    updatedAt: PAGE.updatedAt,
  }),
  def(
    "list_comments",
    "List comments on a Linear issue, project, initiative, document, project milestone, or project/initiative status update. Provide exactly one of `issueId`, `projectId`, `initiativeId`, `documentId`, `milestoneId`, or `statusUpdateId`.",
    {
      cursor: PAGE.cursor,
      documentId: "Document ID or slug (provide exactly one parent)",
      initiativeId:
        "Initiative name, ID, identifier (e.g., I-123), or slug (provide exactly one parent)",
      issueId:
        "Issue ID or identifier (e.g., LIN-123). P-prefixed identifiers (e.g., P-ENG-123) are projects, not issues (provide exactly one parent)",
      limit: PAGE.limit,
      milestoneId:
        "Milestone UUID (provide exactly one parent). Resolve milestone names via `list_milestones` first.",
      orderBy: PAGE.orderBy,
      projectId:
        "Project name, ID, identifier (e.g., P-ENG-123), or slug (provide exactly one parent)",
      statusUpdateId: "Status update UUID (provide exactly one parent).",
      statusUpdateType: "Set only together with `statusUpdateId`.",
    },
  ),
  def(
    "list_releases",
    "List releases in the workspace, with optional filtering by pipeline, stage, version, and text.",
    {
      createdAt: PAGE.createdAt,
      cursor: PAGE.cursor,
      hasReleaseNotes:
        "Filter to releases that do (true) or do not (false) have release notes",
      includeArchived: PAGE.includeArchived,
      includeReleaseNotes: "Include associated release notes",
      limit: PAGE.limit,
      orderBy: PAGE.orderBy,
      pipeline: "Release pipeline ID, slug, or exact name",
      query: "Search release name or version",
      stage: "Release stage ID or exact name",
      stageType: "Filter by stage lifecycle type",
      updatedAt: PAGE.updatedAt,
      version: "Exact version match",
    },
  ),
  def("list_milestones", "List all milestones in a Linear project", {
    project: "Project name, ID, identifier (e.g., P-ENG-123), or slug",
  }),
  def("get_release", "Retrieve details of a release by ID or slug.", {
    id: "Release ID or slug",
    includeReleaseNotes: "Include associated release notes",
  }),
  def(
    "get_release_note",
    "Retrieve release notes by ID or slug, including markdown content.",
    {
      id: "Release notes ID or slug",
      includeReleases: "Include associated releases",
    },
  ),
  def(
    "list_release_notes",
    "List release notes in the workspace, optionally filtered by pipeline or covered release.",
    {
      createdAt: PAGE.createdAt,
      cursor: PAGE.cursor,
      includeArchived: PAGE.includeArchived,
      includeContent: "Include markdown release notes content",
      includeReleases: "Include associated releases",
      limit: PAGE.limit,
      orderBy: PAGE.orderBy,
      pipeline: "Release pipeline ID, slug, or exact name",
      query: "Search release notes title",
      release: "Release ID or slug",
      updatedAt: PAGE.updatedAt,
    },
  ),
  def("list_release_pipelines", "List release pipelines in the workspace.", {
    query: "Search pipeline name",
    team: "Team name or ID",
  }),
  def(
    "save_release",
    "Create or update a release. If `id` is provided, updates the existing release; otherwise creates a new one. When creating, `name` and `pipeline` are required. Release status is modeled as the release pipeline stage.",
    {
      commitSha: "Commit SHA associated with the release",
      completedAt: "Completed timestamp (ISO DateTime, null to remove)",
      createdAt: "Import/create timestamp (ISO DateTime)",
      description: "Release description",
      id: "Release ID or slug to update. Omit to create a new release.",
      name: "Release name (required when creating)",
      pipeline:
        "Release pipeline ID, slug, or exact name (required when creating)",
      stage:
        "Release stage ID, exact name, or lifecycle type within the release pipeline",
      startDate: "Estimated start date (ISO YYYY-MM-DD, null to remove)",
      startedAt: "Started timestamp (ISO DateTime, null to remove)",
      targetDate: "Estimated completion date (ISO YYYY-MM-DD, null to remove)",
      version: "Version identifier",
    },
  ),
  def(
    "save_release_note",
    "Create or update release notes. If `id` is provided, updates the existing release notes; otherwise creates a new one. When creating, `pipeline` and either `releases` or a release range are required. To change parts of the content without resending all of it, pass `patch` instead of `content`.",
    {
      content:
        "Content as Markdown. Do not escape the string — use literal newlines and special characters, not escape sequences. To mention a user, use @displayName (e.g., @johndoe)",
      id: "Release notes ID or slug to update. Omit to create new release notes.",
      patch: PATCH,
      pipeline:
        "Release pipeline ID, slug, or exact name (required when creating)",
      rangeFromRelease: "Oldest release ID or slug in the note range",
      rangeToRelease: "Newest release ID or slug in the note range",
      releases: "Release IDs or slugs to include in the note",
      title: "Release notes title",
    },
  ),
  def("list_issue_statuses", "List available issue statuses in a Linear team", {
    team: "Team name or ID",
  }),
  def(
    "get_issue_status",
    "Retrieve detailed information about an issue status in Linear by name or ID",
    { id: "Status ID", name: "Status name", team: "Team name or ID" },
  ),
  def(
    "retire_issue_label",
    "Retire a Linear issue label so it cannot be applied to new issues. The label stays visible on issues that already have it. Retiring a label group also retires its child labels. Undo with `restore_issue_label`.",
    { id: "Label or label group ID" },
  ),
  def(
    "get_status_updates",
    "List or get project/initiative status updates with their body, health, author, and parent project or initiative. Pass id to get one update and ignore list filters; omit id to list.",
    {
      createdAt: PAGE.createdAt,
      cursor: PAGE.cursor,
      id: "Update ID from get_status_updates results (statusUpdates[].id) or save_status_update's id",
      includeArchived: PAGE.includeArchived,
      initiative:
        "Initiative name, ID, identifier (e.g., I-123), or slug. Filters initiative updates only; omit to include all accessible initiatives",
      limit: PAGE.limit,
      orderBy: PAGE.orderBy,
      project:
        "Project name, ID, identifier (e.g., P-ENG-123), or slug. Filters project updates only; omit to include all accessible projects",
      type: "Type of status update",
      updatedAt: PAGE.updatedAt,
      user: 'Filter by update author: User ID, name, email, or "me". Omit to include all authors',
    },
  ),
  def(
    "get_attachment",
    "Retrieve an issue attachment by ID. Use format=url to get its title and download URL without fetching the file content. Linear upload URLs are signed for five minutes; call again to refresh. External URLs are returned unchanged. Files embedded in comments have no issue attachment ID; use the URLs in list_comments attachments instead. Download and process documents with your own file tools.",
    {
      format:
        "Omit or use content to fetch a Linear-hosted file. Use url for attachment metadata without fetching the file; also supports external links",
      id: "Issue attachment ID from get_issue's attachments array (attachments[].id)",
    },
  ),
  def(
    "get_team",
    "Retrieve details of a specific Linear team, including its parent ID and hierarchy name. Use list_teams with parentTeam or ancestorTeam to find its sub-teams",
    { query: "Team UUID, key, or name" },
  ),
  def(
    "get_template",
    "Retrieve a Linear template by ID or name: the content it pre-fills, the ids it applies, its sub-issues, and its form fields. Pass the template to save_issue or save_project to apply it. References come back as ids, so read a name with the matching tool when you need one. A form template collects its answers through a form, so applying one here creates an issue with the form unanswered.",
    { id: "Template ID or name" },
  ),
];
