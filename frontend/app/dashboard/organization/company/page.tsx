"use client";

import OrganizationShell from "../OrganizationShell";
import CompaniesView from "../_views/CompaniesView";

export default function OrganizationCompanyPage() {
  return <OrganizationShell tab="company"><CompaniesView /></OrganizationShell>;
}
