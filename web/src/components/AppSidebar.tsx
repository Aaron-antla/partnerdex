import type { ComponentType } from 'react';
import {
  Bell,
  Database,
  Filter,
  LayoutDashboard,
  LogOut,
  PanelLeft,
  Star,
  Store,
  TrendingDown,
  Users,
  Wallet,
  CreditCard,
} from 'lucide-react';
import { Logo } from './Logo';
import { NAV, type PageSpec } from '../pages';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';

const ICONS: Record<string, ComponentType<{ className?: string }>> = {
  overview: LayoutDashboard,
  customers: Users,
  revenue: Wallet,
  subscriptions: CreditCard,
  churn: TrendingDown,
  funnel: Filter,
  reviews: Star,
  listings: Store,
  bigquery: Database,
  notifications: Bell,
};

export function NavToggle() {
  const { open, isMobile, openMobile, toggleSidebar } = useSidebar();
  const showing = isMobile ? openMobile : open;
  if (showing) return null;
  return (
    <button
      type="button"
      className="nav-toggle nav-toggle-reopen"
      aria-expanded={false}
      aria-controls="app-sidebar"
      aria-label="Show navigation"
      title="Show navigation"
      onClick={toggleSidebar}
    >
      <PanelLeft />
    </button>
  );
}

export function AppSidebar({
  current,
  onLogout,
}: {
  current: string;
  onLogout?: () => void;
}) {
  const link = (page: PageSpec) => {
    const Icon = ICONS[page.id] ?? LayoutDashboard;
    return (
      <SidebarMenuItem key={page.id}>
        <SidebarMenuButton
          asChild
          isActive={page.id === current}
          tooltip={page.label}
          className="rounded-none bg-transparent hover:bg-[var(--hover-wash)] data-[active=true]:bg-transparent data-[active=true]:font-semibold"
        >
          <a href={`#/${page.id}`}>
            <Icon />
            <span>{page.label}</span>
          </a>
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  };

  return (
    <Sidebar id="app-sidebar" collapsible="offcanvas">
      <SidebarHeader className="gap-0 border-b border-sidebar-border px-3 py-4">
        <div className="flex items-center gap-2.5">
          <Logo />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] font-semibold tracking-[-0.02em]">PartnerDex</p>
            <p className="truncate text-[10px] font-medium tracking-[0.16em] text-muted-foreground uppercase">
              Shopify partners
            </p>
          </div>
          <SidebarTrigger
            className="size-7 shrink-0 rounded-md border border-sidebar-border"
            aria-label="Hide navigation"
            title="Hide navigation"
          />
        </div>
      </SidebarHeader>
      <SidebarContent className="px-2 py-3">
        {NAV.map((group, index) => (
          <SidebarGroup key={group.label || `group-${index}`} className="px-0">
            {group.label ? (
              <SidebarGroupLabel className="h-auto px-2 py-1 text-[10px] font-semibold tracking-[0.16em] text-muted-foreground uppercase">
                {group.label}
              </SidebarGroupLabel>
            ) : null}
            <SidebarGroupContent>
              <SidebarMenu>{group.pages.map(link)}</SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      {onLogout ? (
        <SidebarFooter className="border-t border-sidebar-border">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={onLogout}
                tooltip="Sign out"
                className="rounded-none bg-transparent hover:bg-[var(--hover-wash)]"
              >
                <LogOut />
                <span>Sign out</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      ) : null}
      <SidebarRail />
    </Sidebar>
  );
}
