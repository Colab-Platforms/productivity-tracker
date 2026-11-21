"use client";

import OrganizationShell from "../OrganizationShell";
import ProjectsView from "../_views/ProjectsView";

export default function OrganizationProjectsPage() {
  return <OrganizationShell tab="projects"><ProjectsView /></OrganizationShell>;
}
