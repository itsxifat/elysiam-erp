/*
 * GENERATED FILE. Do not edit.
 *
 * Emitted from openapi.json by `pnpm api:client`. `pnpm check:api-client`
 * regenerates it into a scratch directory and fails the build if this copy
 * differs by a single byte, so an edit here is reverted by the next commit that
 * runs verify — change the contracts or the operation catalog instead.
 */

import type {
  ApprovalDecisionInput,
  ApprovalRequestInput,
  CashInInput,
  ClosePeriodInput,
  CreateUser,
  CredentialResetInput,
  DeactivateUser,
  ReopenPeriodInput,
  SetRoles,
  SwitchOrg,
  ThresholdInput,
} from '@elysium/contracts';

import { request, type ApiRuntime, type RequestOptions } from '../runtime.js';

/** Every operation, with the ability its route declares (§6). */
export const OPERATIONS = {
  accountLedger: {
    method: 'GET',
    path: '/v1/ledger/accounts/{id}/ledger',
    ability: 'read:LedgerReport',
  },
  cashBook: { method: 'GET', path: '/v1/ledger/wallets/{id}/cash-book', ability: 'read:Wallet' },
  cashIn: { method: 'POST', path: '/v1/ledger/cash-in', ability: 'update:Wallet' },
  closePeriod: { method: 'POST', path: '/v1/ledger/periods/close', ability: 'update:LedgerPeriod' },
  createApproval: { method: 'POST', path: '/v1/approvals', ability: 'request:ApprovalRequest' },
  createDemoCostedItem: {
    method: 'POST',
    path: '/v1/demo/costed-items',
    ability: 'create:CostedItem',
  },
  createUser: { method: 'POST', path: '/v1/users', ability: 'create:User' },
  dayBook: { method: 'GET', path: '/v1/ledger/day-book', ability: 'read:LedgerReport' },
  deactivateUser: { method: 'POST', path: '/v1/users/{id}/deactivate', ability: 'update:User' },
  decideApproval: {
    method: 'POST',
    path: '/v1/approvals/{id}/decide',
    ability: 'approve:ApprovalRequest',
  },
  deleteV1CatalogProductsByIdImagesByImageId: {
    method: 'DELETE',
    path: '/v1/catalog/products/{id}/images/{imageId}',
    ability: 'update:Catalog',
  },
  deleteV1HrPayrollRunsByIdInputsByInputId: {
    method: 'DELETE',
    path: '/v1/hr/payroll/runs/{id}/inputs/{inputId}',
    ability: 'create:Payroll',
  },
  deleteV1MarketingCampaignsByIdRefsByRefId: {
    method: 'DELETE',
    path: '/v1/marketing/campaigns/{id}/refs/{refId}',
    ability: 'update:Campaign',
  },
  deleteV1NotifyOptOutsByPhone: {
    method: 'DELETE',
    path: '/v1/notify/opt-outs/{phone}',
    ability: 'update:Campaign',
  },
  deleteV1SupplyDraftsById: {
    method: 'DELETE',
    path: '/v1/supply/drafts/{id}',
    ability: 'update:Supply',
  },
  getApproval: { method: 'GET', path: '/v1/approvals/{id}', ability: 'read:ApprovalRequest' },
  getV1AccountsCashEntries: {
    method: 'GET',
    path: '/v1/accounts/cash-entries',
    ability: 'read:Wallet',
  },
  getV1AccountsCategories: {
    method: 'GET',
    path: '/v1/accounts/categories',
    ability: 'read:Wallet',
  },
  getV1AccountsClosings: { method: 'GET', path: '/v1/accounts/closings', ability: 'read:Wallet' },
  getV1AccountsReportsAging: {
    method: 'GET',
    path: '/v1/accounts/reports/aging',
    ability: 'read:LedgerReport',
  },
  getV1AccountsReportsBalanceSheet: {
    method: 'GET',
    path: '/v1/accounts/reports/balance-sheet',
    ability: 'read:LedgerReport',
  },
  getV1AccountsReportsConsolidatedProfitAndLoss: {
    method: 'GET',
    path: '/v1/accounts/reports/consolidated-profit-and-loss',
    ability: 'read:LedgerReport',
  },
  getV1AccountsReportsConsolidatedWallets: {
    method: 'GET',
    path: '/v1/accounts/reports/consolidated-wallets',
    ability: 'read:LedgerReport',
  },
  getV1AccountsReportsProfitAndLoss: {
    method: 'GET',
    path: '/v1/accounts/reports/profit-and-loss',
    ability: 'read:LedgerReport',
  },
  getV1AccountsWallets: { method: 'GET', path: '/v1/accounts/wallets', ability: 'read:Wallet' },
  getV1AnalyticsConsolidated: {
    method: 'GET',
    path: '/v1/analytics/consolidated',
    ability: 'read:Dashboard',
  },
  getV1AnalyticsDashboard: {
    method: 'GET',
    path: '/v1/analytics/dashboard',
    ability: 'read:Dashboard',
  },
  getV1AnalyticsExport: { method: 'GET', path: '/v1/analytics/export', ability: 'read:Dashboard' },
  getV1AnalyticsInsights: {
    method: 'GET',
    path: '/v1/analytics/insights',
    ability: 'read:Dashboard',
  },
  getV1AnalyticsLeaderboard: {
    method: 'GET',
    path: '/v1/analytics/leaderboard',
    ability: 'read:Leaderboard',
  },
  getV1AnalyticsNarrative: {
    method: 'GET',
    path: '/v1/analytics/narrative',
    ability: 'read:Dashboard',
  },
  getV1ApprovalsThresholds: {
    method: 'GET',
    path: '/v1/approvals/thresholds',
    ability: 'read:ApprovalThreshold',
  },
  getV1Buyers: { method: 'GET', path: '/v1/buyers', ability: 'export:BuyerExport' },
  getV1BuyersExport: { method: 'GET', path: '/v1/buyers/export', ability: 'export:BuyerExport' },
  getV1CatalogAttributes: {
    method: 'GET',
    path: '/v1/catalog/attributes',
    ability: 'read:Catalog',
  },
  getV1CatalogCategories: {
    method: 'GET',
    path: '/v1/catalog/categories',
    ability: 'read:Catalog',
  },
  getV1CatalogProducts: { method: 'GET', path: '/v1/catalog/products', ability: 'read:Catalog' },
  getV1CatalogProductsById: {
    method: 'GET',
    path: '/v1/catalog/products/{id}',
    ability: 'read:Catalog',
  },
  getV1CatalogSkus: { method: 'GET', path: '/v1/catalog/skus', ability: 'read:Catalog' },
  getV1CatalogSkusByIdPriceHistory: {
    method: 'GET',
    path: '/v1/catalog/skus/{id}/price-history',
    ability: 'read:Catalog',
  },
  getV1CourierAccounts: {
    method: 'GET',
    path: '/v1/courier/accounts',
    ability: 'read:CourierSettlement',
  },
  getV1CourierLabels: { method: 'GET', path: '/v1/courier/labels', ability: 'read:Order' },
  getV1CourierParcels: { method: 'GET', path: '/v1/courier/parcels', ability: 'read:Order' },
  getV1CourierParcelsById: {
    method: 'GET',
    path: '/v1/courier/parcels/{id}',
    ability: 'read:Order',
  },
  getV1CourierParcelsByIdReturnable: {
    method: 'GET',
    path: '/v1/courier/parcels/{id}/returnable',
    ability: 'read:Order',
  },
  getV1CourierProviders: {
    method: 'GET',
    path: '/v1/courier/providers',
    ability: 'read:CourierSettlement',
  },
  getV1CourierReportsCodReconciliation: {
    method: 'GET',
    path: '/v1/courier/reports/cod-reconciliation',
    ability: 'read:LedgerReport',
  },
  getV1CourierReportsPerformance: {
    method: 'GET',
    path: '/v1/courier/reports/performance',
    ability: 'read:LedgerReport',
  },
  getV1CourierSelectionPreview: {
    method: 'GET',
    path: '/v1/courier/selection/preview',
    ability: 'read:Order',
  },
  getV1CourierSelectionRules: {
    method: 'GET',
    path: '/v1/courier/selection-rules',
    ability: 'read:CourierSettlement',
  },
  getV1CourierSettlements: {
    method: 'GET',
    path: '/v1/courier/settlements',
    ability: 'read:CourierSettlement',
  },
  getV1CourierSettlementsById: {
    method: 'GET',
    path: '/v1/courier/settlements/{id}',
    ability: 'read:CourierSettlement',
  },
  getV1CourierSettlementsByIdExceptions: {
    method: 'GET',
    path: '/v1/courier/settlements/{id}/exceptions',
    ability: 'read:CourierSettlement',
  },
  getV1CourierSettlementsFetchRuns: {
    method: 'GET',
    path: '/v1/courier/settlements/fetch-runs',
    ability: 'read:CourierSettlement',
  },
  getV1CourierStuck: { method: 'GET', path: '/v1/courier/stuck', ability: 'read:Order' },
  getV1CourierStuckExport: {
    method: 'GET',
    path: '/v1/courier/stuck/export',
    ability: 'read:Order',
  },
  getV1CrmReengagement: {
    method: 'GET',
    path: '/v1/crm/reengagement',
    ability: 'export:BuyerExport',
  },
  getV1CrmReengagementExport: {
    method: 'GET',
    path: '/v1/crm/reengagement/export',
    ability: 'export:BuyerExport',
  },
  getV1Customers: { method: 'GET', path: '/v1/customers', ability: 'read:Customer' },
  getV1CustomersById: { method: 'GET', path: '/v1/customers/{id}', ability: 'read:Customer' },
  getV1CustomersByIdProfile: {
    method: 'GET',
    path: '/v1/customers/{id}/profile',
    ability: 'read:Customer',
  },
  getV1CustomersLookup: { method: 'GET', path: '/v1/customers/lookup', ability: 'read:Customer' },
  getV1DeliveryZones: { method: 'GET', path: '/v1/delivery-zones', ability: 'read:Catalog' },
  getV1DeliveryZonesAreas: {
    method: 'GET',
    path: '/v1/delivery-zones/areas',
    ability: 'read:Catalog',
  },
  getV1DeliveryZonesForArea: {
    method: 'GET',
    path: '/v1/delivery-zones/for-area',
    ability: 'read:Catalog',
  },
  getV1FilesByIdDownload: {
    method: 'GET',
    path: '/v1/files/{id}/download',
    ability: 'read:FileObject',
  },
  getV1FilesContent: { method: 'GET', path: '/v1/files/content', ability: 'public' },
  getV1HrAttendance: { method: 'GET', path: '/v1/hr/attendance', ability: 'read:Employee' },
  getV1HrAttendanceImports: {
    method: 'GET',
    path: '/v1/hr/attendance/imports',
    ability: 'read:Payroll',
  },
  getV1HrBonusRules: { method: 'GET', path: '/v1/hr/bonus-rules', ability: 'read:Payroll' },
  getV1HrBonusRulesVersionsByVersionIdPreview: {
    method: 'GET',
    path: '/v1/hr/bonus-rules/versions/{versionId}/preview',
    ability: 'read:Payroll',
  },
  getV1HrCalendars: { method: 'GET', path: '/v1/hr/calendars', ability: 'read:Employee' },
  getV1HrEmployees: { method: 'GET', path: '/v1/hr/employees', ability: 'read:Employee' },
  getV1HrEmployeesById: { method: 'GET', path: '/v1/hr/employees/{id}', ability: 'read:Employee' },
  getV1HrEmployeesByIdPayoutRef: {
    method: 'GET',
    path: '/v1/hr/employees/{id}/payout-ref',
    ability: 'update:Payroll',
  },
  getV1HrEmployeesByIdSalary: {
    method: 'GET',
    path: '/v1/hr/employees/{id}/salary',
    ability: 'read:Payroll',
  },
  getV1HrLoans: { method: 'GET', path: '/v1/hr/loans', ability: 'read:Payroll' },
  getV1HrLoansById: { method: 'GET', path: '/v1/hr/loans/{id}', ability: 'read:Payroll' },
  getV1HrPayrollRuns: { method: 'GET', path: '/v1/hr/payroll/runs', ability: 'read:Payroll' },
  getV1HrPayrollRunsById: {
    method: 'GET',
    path: '/v1/hr/payroll/runs/{id}',
    ability: 'read:Payroll',
  },
  getV1HrPayrollRunsByIdBonuses: {
    method: 'GET',
    path: '/v1/hr/payroll/runs/{id}/bonuses',
    ability: 'read:Payroll',
  },
  getV1HrPayrollRunsByIdInputs: {
    method: 'GET',
    path: '/v1/hr/payroll/runs/{id}/inputs',
    ability: 'read:Payroll',
  },
  getV1HrPayrollRunsByIdPayslips: {
    method: 'GET',
    path: '/v1/hr/payroll/runs/{id}/payslips',
    ability: 'read:Payroll',
  },
  getV1HrPayrollRunsByIdPayslipsByEmployeeIdPdf: {
    method: 'GET',
    path: '/v1/hr/payroll/runs/{id}/payslips/{employeeId}/pdf',
    ability: 'read:Employee',
  },
  getV1HrPayrollRunsByIdPreview: {
    method: 'GET',
    path: '/v1/hr/payroll/runs/{id}/preview',
    ability: 'read:Payroll',
  },
  getV1HrPayrollWallets: {
    method: 'GET',
    path: '/v1/hr/payroll/wallets',
    ability: 'update:Payroll',
  },
  getV1HrPerformanceMe: { method: 'GET', path: '/v1/hr/performance/me', ability: 'read:Target' },
  getV1HrProductivity: { method: 'GET', path: '/v1/hr/productivity', ability: 'read:Target' },
  getV1HrTargets: { method: 'GET', path: '/v1/hr/targets', ability: 'read:Target' },
  getV1HrTargetsById: { method: 'GET', path: '/v1/hr/targets/{id}', ability: 'read:Target' },
  getV1IntakeSiteKeys: { method: 'GET', path: '/v1/intake/site-keys', ability: 'read:LandingPage' },
  getV1InventoryAdjustments: {
    method: 'GET',
    path: '/v1/inventory/adjustments',
    ability: 'read:StockAdjustment',
  },
  getV1InventoryCounts: { method: 'GET', path: '/v1/inventory/counts', ability: 'read:Stock' },
  getV1InventoryCountsById: {
    method: 'GET',
    path: '/v1/inventory/counts/{id}',
    ability: 'read:Stock',
  },
  getV1InventoryLocations: {
    method: 'GET',
    path: '/v1/inventory/locations',
    ability: 'read:Stock',
  },
  getV1InventoryMovements: {
    method: 'GET',
    path: '/v1/inventory/movements',
    ability: 'read:Stock',
  },
  getV1InventoryReconciliations: {
    method: 'GET',
    path: '/v1/inventory/reconciliations',
    ability: 'read:StockAdjustment',
  },
  getV1InventoryStock: { method: 'GET', path: '/v1/inventory/stock', ability: 'read:Stock' },
  getV1InventoryTransfers: {
    method: 'GET',
    path: '/v1/inventory/transfers',
    ability: 'read:Stock',
  },
  getV1InventoryValuation: { method: 'GET', path: '/v1/inventory/valuation', ability: 'read:Cost' },
  getV1Investors: { method: 'GET', path: '/v1/investors', ability: 'read:Investor' },
  getV1InvestorsById: { method: 'GET', path: '/v1/investors/{id}', ability: 'read:Investor' },
  getV1InvestorsByIdStatement: {
    method: 'GET',
    path: '/v1/investors/{id}/statement',
    ability: 'read:Investor',
  },
  getV1InvestorsDistributions: {
    method: 'GET',
    path: '/v1/investors/distributions',
    ability: 'read:Investor',
  },
  getV1InvestorsDistributionsById: {
    method: 'GET',
    path: '/v1/investors/distributions/{id}',
    ability: 'read:Investor',
  },
  getV1InvestorsDocuments: {
    method: 'GET',
    path: '/v1/investors/documents',
    ability: 'read:Investor',
  },
  getV1InvestorsDocumentsByIdDownload: {
    method: 'GET',
    path: '/v1/investors/documents/{id}/download',
    ability: 'read:Investor',
  },
  getV1InvestorsInvestments: {
    method: 'GET',
    path: '/v1/investors/investments',
    ability: 'read:Investor',
  },
  getV1InvestorsWalletAccounts: {
    method: 'GET',
    path: '/v1/investors/wallet-accounts',
    ability: 'create:Investor',
  },
  getV1InvestorsWithdrawals: {
    method: 'GET',
    path: '/v1/investors/withdrawals',
    ability: 'read:Investor',
  },
  getV1JobsFailed: { method: 'GET', path: '/v1/jobs/failed', ability: 'read:AuditLog' },
  getV1Loans: { method: 'GET', path: '/v1/loans', ability: 'read:CompanyLoan' },
  getV1LoansById: { method: 'GET', path: '/v1/loans/{id}', ability: 'read:CompanyLoan' },
  getV1LoansLenders: { method: 'GET', path: '/v1/loans/lenders', ability: 'read:CompanyLoan' },
  getV1MarketingCampaigns: {
    method: 'GET',
    path: '/v1/marketing/campaigns',
    ability: 'read:Campaign',
  },
  getV1MarketingCapiEvents: {
    method: 'GET',
    path: '/v1/marketing/capi-events',
    ability: 'read:Campaign',
  },
  getV1MarketingDashboard: {
    method: 'GET',
    path: '/v1/marketing/dashboard',
    ability: 'read:Campaign',
  },
  getV1MarketingLeads: { method: 'GET', path: '/v1/marketing/leads', ability: 'read:Campaign' },
  getV1MarketingLeadsSegments: {
    method: 'GET',
    path: '/v1/marketing/leads/segments',
    ability: 'read:Campaign',
  },
  getV1MarketingMetaConnection: {
    method: 'GET',
    path: '/v1/marketing/meta-connection',
    ability: 'read:Campaign',
  },
  getV1MarketingSpend: {
    method: 'GET',
    path: '/v1/marketing/spend',
    ability: 'read:CampaignSpend',
  },
  getV1MarketingSpendCampaigns: {
    method: 'GET',
    path: '/v1/marketing/spend/campaigns',
    ability: 'read:CampaignSpend',
  },
  getV1NotifyMessages: { method: 'GET', path: '/v1/notify/messages', ability: 'read:Campaign' },
  getV1NotifyOptOuts: { method: 'GET', path: '/v1/notify/opt-outs', ability: 'read:Campaign' },
  getV1NotifyTemplates: { method: 'GET', path: '/v1/notify/templates', ability: 'read:Campaign' },
  getV1OrderAdvances: { method: 'GET', path: '/v1/order-advances', ability: 'create:Wallet' },
  getV1Orders: { method: 'GET', path: '/v1/orders', ability: 'read:Order' },
  getV1OrdersAgents: { method: 'GET', path: '/v1/orders/agents', ability: 'read:Order' },
  getV1OrdersAvailability: {
    method: 'GET',
    path: '/v1/orders/availability',
    ability: 'read:Stock',
  },
  getV1OrdersById: { method: 'GET', path: '/v1/orders/{id}', ability: 'read:Order' },
  getV1OrdersByIdAdvances: {
    method: 'GET',
    path: '/v1/orders/{id}/advances',
    ability: 'read:Order',
  },
  getV1OrdersByIdDocument: {
    method: 'GET',
    path: '/v1/orders/{id}/document',
    ability: 'read:Order',
  },
  getV1OrdersDocuments: { method: 'GET', path: '/v1/orders/documents', ability: 'read:Order' },
  getV1OrdersDuplicates: { method: 'GET', path: '/v1/orders/duplicates', ability: 'read:Order' },
  getV1OrdersReturnReasons: {
    method: 'GET',
    path: '/v1/orders/return-reasons',
    ability: 'read:Order',
  },
  getV1PosBranches: { method: 'GET', path: '/v1/pos/branches', ability: 'read:LedgerReport' },
  getV1PosBranchesByIdClosings: {
    method: 'GET',
    path: '/v1/pos/branches/{id}/closings',
    ability: 'read:Wallet',
  },
  getV1PosBranchesByIdSummary: {
    method: 'GET',
    path: '/v1/pos/branches/{id}/summary',
    ability: 'read:LedgerReport',
  },
  getV1PosReceiptsByReceiptNo: {
    method: 'GET',
    path: '/v1/pos/receipts/{receiptNo}',
    ability: 'read:Wallet',
  },
  getV1PosRegisters: { method: 'GET', path: '/v1/pos/registers', ability: 'read:Wallet' },
  getV1PosRegistersByIdPriceList: {
    method: 'GET',
    path: '/v1/pos/registers/{id}/price-list',
    ability: 'read:Catalog',
  },
  getV1PosRegistersByIdSession: {
    method: 'GET',
    path: '/v1/pos/registers/{id}/session',
    ability: 'read:Wallet',
  },
  getV1PosReviews: { method: 'GET', path: '/v1/pos/reviews', ability: 'read:Wallet' },
  getV1PosSalesById: { method: 'GET', path: '/v1/pos/sales/{id}', ability: 'read:Wallet' },
  getV1PosShifts: { method: 'GET', path: '/v1/pos/shifts', ability: 'read:Wallet' },
  getV1PosShiftsById: { method: 'GET', path: '/v1/pos/shifts/{id}', ability: 'read:Wallet' },
  getV1PromoCodes: { method: 'GET', path: '/v1/promo/codes', ability: 'read:LandingPage' },
  getV1PromoCodesByIdRedemptions: {
    method: 'GET',
    path: '/v1/promo/codes/{id}/redemptions',
    ability: 'read:LandingPage',
  },
  getV1SupplyEntries: { method: 'GET', path: '/v1/supply/entries', ability: 'read:Supply' },
  getV1SupplyEntriesById: {
    method: 'GET',
    path: '/v1/supply/entries/{id}',
    ability: 'read:Supply',
  },
  getV1SupplyPayments: { method: 'GET', path: '/v1/supply/payments', ability: 'read:Supply' },
  getV1SupplyReturns: { method: 'GET', path: '/v1/supply/returns', ability: 'read:Supply' },
  getV1SupplySuppliers: { method: 'GET', path: '/v1/supply/suppliers', ability: 'read:Supply' },
  getV1SupplySuppliersById: {
    method: 'GET',
    path: '/v1/supply/suppliers/{id}',
    ability: 'read:Supply',
  },
  getV1SupplySuppliersByIdStatement: {
    method: 'GET',
    path: '/v1/supply/suppliers/{id}/statement',
    ability: 'read:Cost',
  },
  healthLive: { method: 'GET', path: '/health/live', ability: 'public' },
  healthReady: { method: 'GET', path: '/health/ready', ability: 'public' },
  listApprovals: { method: 'GET', path: '/v1/approvals', ability: 'read:ApprovalRequest' },
  listDemoCostedItems: { method: 'GET', path: '/v1/demo/costed-items', ability: 'read:CostedItem' },
  listLedgerAccounts: { method: 'GET', path: '/v1/ledger/accounts', ability: 'read:LedgerReport' },
  listMyOrgs: { method: 'GET', path: '/v1/me/orgs', ability: 'authenticated' },
  listPeriods: { method: 'GET', path: '/v1/ledger/periods', ability: 'read:LedgerPeriod' },
  listUsers: { method: 'GET', path: '/v1/users', ability: 'read:User' },
  listWallets: { method: 'GET', path: '/v1/ledger/wallets', ability: 'read:Wallet' },
  loginBranding: { method: 'GET', path: '/v1/auth/login-branding', ability: 'public' },
  me: { method: 'GET', path: '/v1/me', ability: 'authenticated' },
  partyBalances: { method: 'GET', path: '/v1/ledger/party-balances', ability: 'read:LedgerReport' },
  patchV1AccountsWalletsById: {
    method: 'PATCH',
    path: '/v1/accounts/wallets/{id}',
    ability: 'update:Wallet',
  },
  patchV1CatalogCategoriesById: {
    method: 'PATCH',
    path: '/v1/catalog/categories/{id}',
    ability: 'update:Catalog',
  },
  patchV1CatalogProductsById: {
    method: 'PATCH',
    path: '/v1/catalog/products/{id}',
    ability: 'update:Catalog',
  },
  patchV1CustomersById: { method: 'PATCH', path: '/v1/customers/{id}', ability: 'update:Customer' },
  patchV1HrEmployeesById: {
    method: 'PATCH',
    path: '/v1/hr/employees/{id}',
    ability: 'update:Employee',
  },
  patchV1InventoryLocationsById: {
    method: 'PATCH',
    path: '/v1/inventory/locations/{id}',
    ability: 'update:Catalog',
  },
  patchV1InvestorsById: { method: 'PATCH', path: '/v1/investors/{id}', ability: 'update:Investor' },
  patchV1MarketingCampaignsById: {
    method: 'PATCH',
    path: '/v1/marketing/campaigns/{id}',
    ability: 'update:Campaign',
  },
  patchV1MarketingLeadsById: {
    method: 'PATCH',
    path: '/v1/marketing/leads/{id}',
    ability: 'update:Campaign',
  },
  patchV1OrdersById: { method: 'PATCH', path: '/v1/orders/{id}', ability: 'update:Order' },
  patchV1PosRegistersById: {
    method: 'PATCH',
    path: '/v1/pos/registers/{id}',
    ability: 'update:Wallet',
  },
  patchV1PromoCodesById: {
    method: 'PATCH',
    path: '/v1/promo/codes/{id}',
    ability: 'update:LandingPage',
  },
  patchV1SupplyDraftsById: {
    method: 'PATCH',
    path: '/v1/supply/drafts/{id}',
    ability: 'update:Supply',
  },
  patchV1SupplySuppliersById: {
    method: 'PATCH',
    path: '/v1/supply/suppliers/{id}',
    ability: 'update:Supply',
  },
  postPublicV1Orders: { method: 'POST', path: '/public/v1/orders', ability: 'public' },
  postV1AccountsCashEntries: {
    method: 'POST',
    path: '/v1/accounts/cash-entries',
    ability: 'update:Wallet',
  },
  postV1AccountsClosings: {
    method: 'POST',
    path: '/v1/accounts/closings',
    ability: 'update:Wallet',
  },
  postV1AccountsTransfers: {
    method: 'POST',
    path: '/v1/accounts/transfers',
    ability: 'update:Wallet',
  },
  postV1AccountsWallets: { method: 'POST', path: '/v1/accounts/wallets', ability: 'create:Wallet' },
  postV1AnalyticsRollupsRefresh: {
    method: 'POST',
    path: '/v1/analytics/rollups/refresh',
    ability: 'update:Dashboard',
  },
  postV1CatalogAttributes: {
    method: 'POST',
    path: '/v1/catalog/attributes',
    ability: 'create:Catalog',
  },
  postV1CatalogAttributesByIdValues: {
    method: 'POST',
    path: '/v1/catalog/attributes/{id}/values',
    ability: 'create:Catalog',
  },
  postV1CatalogCategories: {
    method: 'POST',
    path: '/v1/catalog/categories',
    ability: 'create:Catalog',
  },
  postV1CatalogImportsPrices: {
    method: 'POST',
    path: '/v1/catalog/imports/prices',
    ability: 'update:Catalog',
  },
  postV1CatalogImportsPricesDryRun: {
    method: 'POST',
    path: '/v1/catalog/imports/prices/dry-run',
    ability: 'read:Catalog',
  },
  postV1CatalogLabels: { method: 'POST', path: '/v1/catalog/labels', ability: 'read:Catalog' },
  postV1CatalogProducts: {
    method: 'POST',
    path: '/v1/catalog/products',
    ability: 'create:Catalog',
  },
  postV1CatalogProductsByIdImages: {
    method: 'POST',
    path: '/v1/catalog/products/{id}/images',
    ability: 'update:Catalog',
  },
  postV1CatalogProductsByIdVariants: {
    method: 'POST',
    path: '/v1/catalog/products/{id}/variants',
    ability: 'update:Catalog',
  },
  postV1CourierAccounts: {
    method: 'POST',
    path: '/v1/courier/accounts',
    ability: 'update:CourierSettlement',
  },
  postV1CourierParcels: { method: 'POST', path: '/v1/courier/parcels', ability: 'update:Order' },
  postV1CourierParcelsBulk: {
    method: 'POST',
    path: '/v1/courier/parcels/bulk',
    ability: 'update:Order',
  },
  postV1CourierParcelsByIdEscalations: {
    method: 'POST',
    path: '/v1/courier/parcels/{id}/escalations',
    ability: 'update:Order',
  },
  postV1CourierParcelsByIdHandover: {
    method: 'POST',
    path: '/v1/courier/parcels/{id}/handover',
    ability: 'update:Order',
  },
  postV1CourierParcelsByIdReceiveReturn: {
    method: 'POST',
    path: '/v1/courier/parcels/{id}/receive-return',
    ability: 'update:Order',
  },
  postV1CourierParcelsByIdStatus: {
    method: 'POST',
    path: '/v1/courier/parcels/{id}/status',
    ability: 'update:Order',
  },
  postV1CourierSettlements: {
    method: 'POST',
    path: '/v1/courier/settlements',
    ability: 'create:CourierSettlement',
  },
  postV1CourierSettlementsByIdApproval: {
    method: 'POST',
    path: '/v1/courier/settlements/{id}/approval',
    ability: 'update:CourierSettlement',
  },
  postV1CourierSettlementsByIdReject: {
    method: 'POST',
    path: '/v1/courier/settlements/{id}/reject',
    ability: 'update:CourierSettlement',
  },
  postV1CourierSettlementsFetch: {
    method: 'POST',
    path: '/v1/courier/settlements/fetch',
    ability: 'create:CourierSettlement',
  },
  postV1CourierStuckRepoll: {
    method: 'POST',
    path: '/v1/courier/stuck/repoll',
    ability: 'update:Order',
  },
  postV1CourierWebhooksByOrgIdByProvider: {
    method: 'POST',
    path: '/v1/courier/webhooks/{orgId}/{provider}',
    ability: 'public',
  },
  postV1Customers: { method: 'POST', path: '/v1/customers', ability: 'create:Customer' },
  postV1Files: { method: 'POST', path: '/v1/files', ability: 'create:FileObject' },
  postV1FilesByIdFinalize: {
    method: 'POST',
    path: '/v1/files/{id}/finalize',
    ability: 'create:FileObject',
  },
  postV1HrAttendanceImports: {
    method: 'POST',
    path: '/v1/hr/attendance/imports',
    ability: 'update:Employee',
  },
  postV1HrBonusRules: { method: 'POST', path: '/v1/hr/bonus-rules', ability: 'create:Payroll' },
  postV1HrBonusRulesByIdVersions: {
    method: 'POST',
    path: '/v1/hr/bonus-rules/{id}/versions',
    ability: 'create:Payroll',
  },
  postV1HrBonusRulesVersionsByVersionIdSubmit: {
    method: 'POST',
    path: '/v1/hr/bonus-rules/versions/{versionId}/submit',
    ability: 'create:Payroll',
  },
  postV1HrCalendars: { method: 'POST', path: '/v1/hr/calendars', ability: 'create:Payroll' },
  postV1HrCalendarsByIdHolidays: {
    method: 'POST',
    path: '/v1/hr/calendars/{id}/holidays',
    ability: 'create:Payroll',
  },
  postV1HrEmployees: { method: 'POST', path: '/v1/hr/employees', ability: 'create:Employee' },
  postV1HrEmployeesByIdSalary: {
    method: 'POST',
    path: '/v1/hr/employees/{id}/salary',
    ability: 'create:Payroll',
  },
  postV1HrLoans: { method: 'POST', path: '/v1/hr/loans', ability: 'create:Payroll' },
  postV1HrLoansByIdDisburse: {
    method: 'POST',
    path: '/v1/hr/loans/{id}/disburse',
    ability: 'update:Payroll',
  },
  postV1HrPayrollRuns: { method: 'POST', path: '/v1/hr/payroll/runs', ability: 'create:Payroll' },
  postV1HrPayrollRunsByIdBonuses: {
    method: 'POST',
    path: '/v1/hr/payroll/runs/{id}/bonuses',
    ability: 'create:Payroll',
  },
  postV1HrPayrollRunsByIdCancel: {
    method: 'POST',
    path: '/v1/hr/payroll/runs/{id}/cancel',
    ability: 'create:Payroll',
  },
  postV1HrPayrollRunsByIdInputs: {
    method: 'POST',
    path: '/v1/hr/payroll/runs/{id}/inputs',
    ability: 'create:Payroll',
  },
  postV1HrPayrollRunsByIdPay: {
    method: 'POST',
    path: '/v1/hr/payroll/runs/{id}/pay',
    ability: 'update:Payroll',
  },
  postV1HrPayrollRunsByIdSubmit: {
    method: 'POST',
    path: '/v1/hr/payroll/runs/{id}/submit',
    ability: 'create:Payroll',
  },
  postV1HrTargets: { method: 'POST', path: '/v1/hr/targets', ability: 'create:Target' },
  postV1HrTargetsByIdCancel: {
    method: 'POST',
    path: '/v1/hr/targets/{id}/cancel',
    ability: 'update:Target',
  },
  postV1HrTargetsRefresh: {
    method: 'POST',
    path: '/v1/hr/targets/refresh',
    ability: 'update:Target',
  },
  postV1IntakeSiteKeys: {
    method: 'POST',
    path: '/v1/intake/site-keys',
    ability: 'create:LandingPage',
  },
  postV1IntakeSiteKeysByIdRevoke: {
    method: 'POST',
    path: '/v1/intake/site-keys/{id}/revoke',
    ability: 'update:LandingPage',
  },
  postV1InventoryAdjustments: {
    method: 'POST',
    path: '/v1/inventory/adjustments',
    ability: 'request:StockAdjustment',
  },
  postV1InventoryCounts: {
    method: 'POST',
    path: '/v1/inventory/counts',
    ability: 'request:StockAdjustment',
  },
  postV1InventoryCountsByIdClose: {
    method: 'POST',
    path: '/v1/inventory/counts/{id}/close',
    ability: 'request:StockAdjustment',
  },
  postV1InventoryCountsByIdSubmit: {
    method: 'POST',
    path: '/v1/inventory/counts/{id}/submit',
    ability: 'request:StockAdjustment',
  },
  postV1InventoryLocations: {
    method: 'POST',
    path: '/v1/inventory/locations',
    ability: 'create:Catalog',
  },
  postV1InventoryTransfers: {
    method: 'POST',
    path: '/v1/inventory/transfers',
    ability: 'request:StockAdjustment',
  },
  postV1InventoryTransfersByIdReceive: {
    method: 'POST',
    path: '/v1/inventory/transfers/{id}/receive',
    ability: 'request:StockAdjustment',
  },
  postV1Investors: { method: 'POST', path: '/v1/investors', ability: 'create:Investor' },
  postV1InvestorsDistributions: {
    method: 'POST',
    path: '/v1/investors/distributions',
    ability: 'create:Investor',
  },
  postV1InvestorsDistributionsByIdReject: {
    method: 'POST',
    path: '/v1/investors/distributions/{id}/reject',
    ability: 'create:Investor',
  },
  postV1InvestorsDocuments: {
    method: 'POST',
    path: '/v1/investors/documents',
    ability: 'create:Investor',
  },
  postV1InvestorsInvestments: {
    method: 'POST',
    path: '/v1/investors/investments',
    ability: 'create:Investor',
  },
  postV1InvestorsWithdrawals: {
    method: 'POST',
    path: '/v1/investors/withdrawals',
    ability: 'create:Investor',
  },
  postV1InvestorsWithdrawalsByIdPay: {
    method: 'POST',
    path: '/v1/investors/withdrawals/{id}/pay',
    ability: 'update:Investor',
  },
  postV1InvestorsWithdrawalsByIdReject: {
    method: 'POST',
    path: '/v1/investors/withdrawals/{id}/reject',
    ability: 'update:Investor',
  },
  postV1InvestorsWithdrawalsByIdReview: {
    method: 'POST',
    path: '/v1/investors/withdrawals/{id}/review',
    ability: 'update:Investor',
  },
  postV1Loans: { method: 'POST', path: '/v1/loans', ability: 'create:CompanyLoan' },
  postV1LoansByIdPayments: {
    method: 'POST',
    path: '/v1/loans/{id}/payments',
    ability: 'update:CompanyLoan',
  },
  postV1LoansByIdVoid: {
    method: 'POST',
    path: '/v1/loans/{id}/void',
    ability: 'update:CompanyLoan',
  },
  postV1LoansLenders: { method: 'POST', path: '/v1/loans/lenders', ability: 'create:CompanyLoan' },
  postV1LoansPreview: { method: 'POST', path: '/v1/loans/preview', ability: 'read:CompanyLoan' },
  postV1MarketingCampaigns: {
    method: 'POST',
    path: '/v1/marketing/campaigns',
    ability: 'create:Campaign',
  },
  postV1MarketingCampaignsByIdRefs: {
    method: 'POST',
    path: '/v1/marketing/campaigns/{id}/refs',
    ability: 'update:Campaign',
  },
  postV1MarketingLeads: { method: 'POST', path: '/v1/marketing/leads', ability: 'create:Campaign' },
  postV1MarketingMetaImport: {
    method: 'POST',
    path: '/v1/marketing/meta/import',
    ability: 'create:CampaignSpend',
  },
  postV1NotifyOptOuts: { method: 'POST', path: '/v1/notify/opt-outs', ability: 'update:Campaign' },
  postV1OrderAdvancesByIdRefund: {
    method: 'POST',
    path: '/v1/order-advances/{id}/refund',
    ability: 'create:Wallet',
  },
  postV1OrderAdvancesByIdReject: {
    method: 'POST',
    path: '/v1/order-advances/{id}/reject',
    ability: 'create:Wallet',
  },
  postV1OrderAdvancesByIdVerify: {
    method: 'POST',
    path: '/v1/order-advances/{id}/verify',
    ability: 'create:Wallet',
  },
  postV1OrderAdvancesByIdVoid: {
    method: 'POST',
    path: '/v1/order-advances/{id}/void',
    ability: 'create:Wallet',
  },
  postV1Orders: { method: 'POST', path: '/v1/orders', ability: 'create:Order' },
  postV1OrdersBulkConfirm: {
    method: 'POST',
    path: '/v1/orders/bulk-confirm',
    ability: 'update:Order',
  },
  postV1OrdersBulkTransition: {
    method: 'POST',
    path: '/v1/orders/bulk-transition',
    ability: 'update:Order',
  },
  postV1OrdersByIdAdvances: {
    method: 'POST',
    path: '/v1/orders/{id}/advances',
    ability: 'update:Order',
  },
  postV1OrdersByIdAssign: {
    method: 'POST',
    path: '/v1/orders/{id}/assign',
    ability: 'update:Order',
  },
  postV1OrdersByIdCancel: {
    method: 'POST',
    path: '/v1/orders/{id}/cancel',
    ability: 'update:Order',
  },
  postV1OrdersByIdClaim: { method: 'POST', path: '/v1/orders/{id}/claim', ability: 'update:Order' },
  postV1OrdersByIdConfirm: {
    method: 'POST',
    path: '/v1/orders/{id}/confirm',
    ability: 'update:Order',
  },
  postV1OrdersByIdDeliver: {
    method: 'POST',
    path: '/v1/orders/{id}/deliver',
    ability: 'update:Order',
  },
  postV1OrdersByIdExchange: {
    method: 'POST',
    path: '/v1/orders/{id}/exchange',
    ability: 'create:Order',
  },
  postV1OrdersByIdHold: { method: 'POST', path: '/v1/orders/{id}/hold', ability: 'update:Order' },
  postV1OrdersByIdPack: { method: 'POST', path: '/v1/orders/{id}/pack', ability: 'update:Order' },
  postV1OrdersByIdPartialDelivery: {
    method: 'POST',
    path: '/v1/orders/{id}/partial-delivery',
    ability: 'update:Order',
  },
  postV1OrdersByIdReceiveReturn: {
    method: 'POST',
    path: '/v1/orders/{id}/receive-return',
    ability: 'update:Order',
  },
  postV1OrdersByIdReleaseHold: {
    method: 'POST',
    path: '/v1/orders/{id}/release-hold',
    ability: 'update:Order',
  },
  postV1OrdersByIdShip: { method: 'POST', path: '/v1/orders/{id}/ship', ability: 'update:Order' },
  postV1OrdersByIdStartReturn: {
    method: 'POST',
    path: '/v1/orders/{id}/start-return',
    ability: 'update:Order',
  },
  postV1PosBranchesByIdClosings: {
    method: 'POST',
    path: '/v1/pos/branches/{id}/closings',
    ability: 'update:Wallet',
  },
  postV1PosPromoCodesCheck: {
    method: 'POST',
    path: '/v1/pos/promo-codes/check',
    ability: 'update:Wallet',
  },
  postV1PosRegisters: { method: 'POST', path: '/v1/pos/registers', ability: 'update:Wallet' },
  postV1PosReviewsByIdResolve: {
    method: 'POST',
    path: '/v1/pos/reviews/{id}/resolve',
    ability: 'update:Wallet',
  },
  postV1PosShifts: { method: 'POST', path: '/v1/pos/shifts', ability: 'update:Wallet' },
  postV1PosShiftsByIdClose: {
    method: 'POST',
    path: '/v1/pos/shifts/{id}/close',
    ability: 'update:Wallet',
  },
  postV1PosSync: { method: 'POST', path: '/v1/pos/sync', ability: 'update:Wallet' },
  postV1PromoCheck: { method: 'POST', path: '/v1/promo/check', ability: 'read:LandingPage' },
  postV1PromoCodes: { method: 'POST', path: '/v1/promo/codes', ability: 'create:LandingPage' },
  postV1SupplyAdvanceApplications: {
    method: 'POST',
    path: '/v1/supply/advance-applications',
    ability: 'read:Cost',
  },
  postV1SupplyDrafts: { method: 'POST', path: '/v1/supply/drafts', ability: 'create:Supply' },
  postV1SupplyEntries: { method: 'POST', path: '/v1/supply/entries', ability: 'read:Cost' },
  postV1SupplyEntriesByIdReceive: {
    method: 'POST',
    path: '/v1/supply/entries/{id}/receive',
    ability: 'read:Cost',
  },
  postV1SupplyPayments: { method: 'POST', path: '/v1/supply/payments', ability: 'read:Cost' },
  postV1SupplyReturns: { method: 'POST', path: '/v1/supply/returns', ability: 'read:Cost' },
  postV1SupplySuppliers: { method: 'POST', path: '/v1/supply/suppliers', ability: 'create:Supply' },
  postV1SupplySuppliersByIdContacts: {
    method: 'POST',
    path: '/v1/supply/suppliers/{id}/contacts',
    ability: 'update:Supply',
  },
  postV1SupplySuppliersByIdDocuments: {
    method: 'POST',
    path: '/v1/supply/suppliers/{id}/documents',
    ability: 'update:Supply',
  },
  postV1SupplySuppliersByIdNotes: {
    method: 'POST',
    path: '/v1/supply/suppliers/{id}/notes',
    ability: 'update:Supply',
  },
  postV1Track: { method: 'POST', path: '/v1/track', ability: 'public' },
  putV1CatalogPrices: { method: 'PUT', path: '/v1/catalog/prices', ability: 'update:Catalog' },
  putV1CatalogProductsByIdImagesOrder: {
    method: 'PUT',
    path: '/v1/catalog/products/{id}/images/order',
    ability: 'update:Catalog',
  },
  putV1CatalogSkusByIdBarcode: {
    method: 'PUT',
    path: '/v1/catalog/skus/{id}/barcode',
    ability: 'update:Catalog',
  },
  putV1CourierSelectionRules: {
    method: 'PUT',
    path: '/v1/courier/selection-rules',
    ability: 'update:CourierSettlement',
  },
  putV1DeliveryZones: { method: 'PUT', path: '/v1/delivery-zones', ability: 'update:Catalog' },
  putV1FilesContent: { method: 'PUT', path: '/v1/files/content', ability: 'public' },
  putV1HrAttendance: { method: 'PUT', path: '/v1/hr/attendance', ability: 'update:Employee' },
  putV1InventoryCountsByIdLines: {
    method: 'PUT',
    path: '/v1/inventory/counts/{id}/lines',
    ability: 'request:StockAdjustment',
  },
  putV1InventoryReorderLevels: {
    method: 'PUT',
    path: '/v1/inventory/reorder-levels',
    ability: 'update:Catalog',
  },
  putV1MarketingMetaConnection: {
    method: 'PUT',
    path: '/v1/marketing/meta-connection',
    ability: 'update:Campaign',
  },
  putV1MarketingSpend: {
    method: 'PUT',
    path: '/v1/marketing/spend',
    ability: 'create:CampaignSpend',
  },
  putV1NotifyTemplates: { method: 'PUT', path: '/v1/notify/templates', ability: 'update:Campaign' },
  reopenPeriod: {
    method: 'POST',
    path: '/v1/ledger/periods/reopen',
    ability: 'update:LedgerPeriod',
  },
  resetUserTwoFactor: {
    method: 'POST',
    path: '/v1/users/{id}/two-factor/reset',
    ability: 'update:User',
  },
  setApprovalThresholds: {
    method: 'PUT',
    path: '/v1/approvals/thresholds',
    ability: 'update:ApprovalThreshold',
  },
  setUserRoles: { method: 'PUT', path: '/v1/users/{id}/roles', ability: 'update:User' },
  switchOrg: { method: 'POST', path: '/v1/me/active-org', ability: 'authenticated' },
  trialBalance: { method: 'GET', path: '/v1/ledger/trial-balance', ability: 'read:LedgerReport' },
  userPasswordLink: {
    method: 'POST',
    path: '/v1/users/{id}/password-link',
    ability: 'update:User',
  },
} as const;

export type OperationName = keyof typeof OPERATIONS;

/**
 * The typed client.
 *
 * Return types are `unknown` wherever `packages/contracts` does not yet
 * describe the response. That is deliberate: a made-up response type would be
 * relied on by a frontend and would fail at runtime rather than at compile
 * time (follow-up F-M04-1).
 */
export function createApiClient(runtime: ApiRuntime) {
  return {
    /** Every posting to one account over a date range. */
    accountLedger: (
      input: {
        readonly path: { readonly id: string };
        readonly query: { readonly from?: string; readonly to: string };
      },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.accountLedger, input, options),
    /** Movements through one wallet over a date range. */
    cashBook: (
      input: {
        readonly path: { readonly id: string };
        readonly query: { readonly from?: string; readonly to: string };
      },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.cashBook, input, options),
    /** Record money received into a wallet. */
    cashIn: (input: { readonly body: CashInInput }, options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.cashIn, input, options),
    /** Close a month, locking every date up to its end. */
    closePeriod: (
      input: { readonly body: ClosePeriodInput },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.closePeriod, input, options),
    /** Raise an approval request for a money-moving action. */
    createApproval: (
      input: { readonly body: ApprovalRequestInput },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.createApproval, input, options),
    /** Test fixture for the permission matrix. Not deployed to production. */
    createDemoCostedItem: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.createDemoCostedItem, undefined, options),
    /** Invite a user into this organization with one or more roles. */
    createUser: (
      input: { readonly body: CreateUser },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.createUser, input, options),
    /** Every journal posted in a date range, newest first. */
    dayBook: (
      input: { readonly query: { readonly from: string; readonly to: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.dayBook, input, options),
    /** Switch a leaver off here: their roles end, and so do their sessions. */
    deactivateUser: (
      input: { readonly path: { readonly id: string }; readonly body: DeactivateUser },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.deactivateUser, input, options),
    /** Approve or reject a request as the checker. */
    decideApproval: (
      input: { readonly path: { readonly id: string }; readonly body: ApprovalDecisionInput },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.decideApproval, input, options),
    /** DELETE /v1/catalog/products/:id/images/:imageId */
    deleteV1CatalogProductsByIdImagesByImageId: (
      input: { readonly path: { readonly id: string; readonly imageId: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.deleteV1CatalogProductsByIdImagesByImageId, input, options),
    /** DELETE /v1/hr/payroll/runs/:id/inputs/:inputId */
    deleteV1HrPayrollRunsByIdInputsByInputId: (
      input: { readonly path: { readonly id: string; readonly inputId: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.deleteV1HrPayrollRunsByIdInputsByInputId, input, options),
    /** DELETE /v1/marketing/campaigns/:id/refs/:refId */
    deleteV1MarketingCampaignsByIdRefsByRefId: (
      input: { readonly path: { readonly id: string; readonly refId: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.deleteV1MarketingCampaignsByIdRefsByRefId, input, options),
    /** DELETE /v1/notify/opt-outs/:phone */
    deleteV1NotifyOptOutsByPhone: (
      input: { readonly path: { readonly phone: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.deleteV1NotifyOptOutsByPhone, input, options),
    /** DELETE /v1/supply/drafts/:id */
    deleteV1SupplyDraftsById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.deleteV1SupplyDraftsById, input, options),
    /** One approval request, with its decision lineage. */
    getApproval: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.getApproval, input, options),
    /** GET /v1/accounts/cash-entries */
    getV1AccountsCashEntries: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1AccountsCashEntries, undefined, options),
    /** GET /v1/accounts/categories */
    getV1AccountsCategories: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1AccountsCategories, undefined, options),
    /** GET /v1/accounts/closings */
    getV1AccountsClosings: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1AccountsClosings, undefined, options),
    /** GET /v1/accounts/reports/aging */
    getV1AccountsReportsAging: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1AccountsReportsAging, undefined, options),
    /** GET /v1/accounts/reports/balance-sheet */
    getV1AccountsReportsBalanceSheet: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1AccountsReportsBalanceSheet, undefined, options),
    /** GET /v1/accounts/reports/consolidated-profit-and-loss */
    getV1AccountsReportsConsolidatedProfitAndLoss: (options?: RequestOptions): Promise<unknown> =>
      request(
        runtime,
        OPERATIONS.getV1AccountsReportsConsolidatedProfitAndLoss,
        undefined,
        options,
      ),
    /** GET /v1/accounts/reports/consolidated-wallets */
    getV1AccountsReportsConsolidatedWallets: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1AccountsReportsConsolidatedWallets, undefined, options),
    /** GET /v1/accounts/reports/profit-and-loss */
    getV1AccountsReportsProfitAndLoss: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1AccountsReportsProfitAndLoss, undefined, options),
    /** GET /v1/accounts/wallets */
    getV1AccountsWallets: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1AccountsWallets, undefined, options),
    /** GET /v1/analytics/consolidated */
    getV1AnalyticsConsolidated: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1AnalyticsConsolidated, undefined, options),
    /** GET /v1/analytics/dashboard */
    getV1AnalyticsDashboard: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1AnalyticsDashboard, undefined, options),
    /** GET /v1/analytics/export */
    getV1AnalyticsExport: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1AnalyticsExport, undefined, options),
    /** GET /v1/analytics/insights */
    getV1AnalyticsInsights: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1AnalyticsInsights, undefined, options),
    /** GET /v1/analytics/leaderboard */
    getV1AnalyticsLeaderboard: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1AnalyticsLeaderboard, undefined, options),
    /** GET /v1/analytics/narrative */
    getV1AnalyticsNarrative: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1AnalyticsNarrative, undefined, options),
    /** GET /v1/approvals/thresholds */
    getV1ApprovalsThresholds: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1ApprovalsThresholds, undefined, options),
    /** GET /v1/buyers */
    getV1Buyers: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1Buyers, undefined, options),
    /** GET /v1/buyers/export */
    getV1BuyersExport: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1BuyersExport, undefined, options),
    /** GET /v1/catalog/attributes */
    getV1CatalogAttributes: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1CatalogAttributes, undefined, options),
    /** GET /v1/catalog/categories */
    getV1CatalogCategories: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1CatalogCategories, undefined, options),
    /** GET /v1/catalog/products */
    getV1CatalogProducts: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1CatalogProducts, undefined, options),
    /** GET /v1/catalog/products/:id */
    getV1CatalogProductsById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.getV1CatalogProductsById, input, options),
    /** GET /v1/catalog/skus */
    getV1CatalogSkus: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1CatalogSkus, undefined, options),
    /** GET /v1/catalog/skus/:id/price-history */
    getV1CatalogSkusByIdPriceHistory: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1CatalogSkusByIdPriceHistory, input, options),
    /** GET /v1/courier/accounts */
    getV1CourierAccounts: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1CourierAccounts, undefined, options),
    /** GET /v1/courier/labels */
    getV1CourierLabels: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1CourierLabels, undefined, options),
    /** GET /v1/courier/parcels */
    getV1CourierParcels: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1CourierParcels, undefined, options),
    /** GET /v1/courier/parcels/:id */
    getV1CourierParcelsById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.getV1CourierParcelsById, input, options),
    /** GET /v1/courier/parcels/:id/returnable */
    getV1CourierParcelsByIdReturnable: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1CourierParcelsByIdReturnable, input, options),
    /** GET /v1/courier/providers */
    getV1CourierProviders: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1CourierProviders, undefined, options),
    /** GET /v1/courier/reports/cod-reconciliation */
    getV1CourierReportsCodReconciliation: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1CourierReportsCodReconciliation, undefined, options),
    /** GET /v1/courier/reports/performance */
    getV1CourierReportsPerformance: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1CourierReportsPerformance, undefined, options),
    /** GET /v1/courier/selection/preview */
    getV1CourierSelectionPreview: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1CourierSelectionPreview, undefined, options),
    /** GET /v1/courier/selection-rules */
    getV1CourierSelectionRules: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1CourierSelectionRules, undefined, options),
    /** GET /v1/courier/settlements */
    getV1CourierSettlements: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1CourierSettlements, undefined, options),
    /** GET /v1/courier/settlements/:id */
    getV1CourierSettlementsById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.getV1CourierSettlementsById, input, options),
    /** GET /v1/courier/settlements/:id/exceptions */
    getV1CourierSettlementsByIdExceptions: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1CourierSettlementsByIdExceptions, input, options),
    /** GET /v1/courier/settlements/fetch-runs */
    getV1CourierSettlementsFetchRuns: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1CourierSettlementsFetchRuns, undefined, options),
    /** GET /v1/courier/stuck */
    getV1CourierStuck: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1CourierStuck, undefined, options),
    /** GET /v1/courier/stuck/export */
    getV1CourierStuckExport: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1CourierStuckExport, undefined, options),
    /** GET /v1/crm/reengagement */
    getV1CrmReengagement: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1CrmReengagement, undefined, options),
    /** GET /v1/crm/reengagement/export */
    getV1CrmReengagementExport: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1CrmReengagementExport, undefined, options),
    /** GET /v1/customers */
    getV1Customers: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1Customers, undefined, options),
    /** GET /v1/customers/:id */
    getV1CustomersById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.getV1CustomersById, input, options),
    /** GET /v1/customers/:id/profile */
    getV1CustomersByIdProfile: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.getV1CustomersByIdProfile, input, options),
    /** GET /v1/customers/lookup */
    getV1CustomersLookup: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1CustomersLookup, undefined, options),
    /** GET /v1/delivery-zones */
    getV1DeliveryZones: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1DeliveryZones, undefined, options),
    /** GET /v1/delivery-zones/areas */
    getV1DeliveryZonesAreas: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1DeliveryZonesAreas, undefined, options),
    /** GET /v1/delivery-zones/for-area */
    getV1DeliveryZonesForArea: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1DeliveryZonesForArea, undefined, options),
    /** GET /v1/files/:id/download */
    getV1FilesByIdDownload: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.getV1FilesByIdDownload, input, options),
    /** GET /v1/files/content */
    getV1FilesContent: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1FilesContent, undefined, options),
    /** GET /v1/hr/attendance */
    getV1HrAttendance: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1HrAttendance, undefined, options),
    /** GET /v1/hr/attendance/imports */
    getV1HrAttendanceImports: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1HrAttendanceImports, undefined, options),
    /** GET /v1/hr/bonus-rules */
    getV1HrBonusRules: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1HrBonusRules, undefined, options),
    /** GET /v1/hr/bonus-rules/versions/:versionId/preview */
    getV1HrBonusRulesVersionsByVersionIdPreview: (
      input: { readonly path: { readonly versionId: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1HrBonusRulesVersionsByVersionIdPreview, input, options),
    /** GET /v1/hr/calendars */
    getV1HrCalendars: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1HrCalendars, undefined, options),
    /** GET /v1/hr/employees */
    getV1HrEmployees: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1HrEmployees, undefined, options),
    /** GET /v1/hr/employees/:id */
    getV1HrEmployeesById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.getV1HrEmployeesById, input, options),
    /** GET /v1/hr/employees/:id/payout-ref */
    getV1HrEmployeesByIdPayoutRef: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1HrEmployeesByIdPayoutRef, input, options),
    /** GET /v1/hr/employees/:id/salary */
    getV1HrEmployeesByIdSalary: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.getV1HrEmployeesByIdSalary, input, options),
    /** GET /v1/hr/loans */
    getV1HrLoans: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1HrLoans, undefined, options),
    /** GET /v1/hr/loans/:id */
    getV1HrLoansById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.getV1HrLoansById, input, options),
    /** GET /v1/hr/payroll/runs */
    getV1HrPayrollRuns: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1HrPayrollRuns, undefined, options),
    /** GET /v1/hr/payroll/runs/:id */
    getV1HrPayrollRunsById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.getV1HrPayrollRunsById, input, options),
    /** GET /v1/hr/payroll/runs/:id/bonuses */
    getV1HrPayrollRunsByIdBonuses: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1HrPayrollRunsByIdBonuses, input, options),
    /** GET /v1/hr/payroll/runs/:id/inputs */
    getV1HrPayrollRunsByIdInputs: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1HrPayrollRunsByIdInputs, input, options),
    /** GET /v1/hr/payroll/runs/:id/payslips */
    getV1HrPayrollRunsByIdPayslips: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1HrPayrollRunsByIdPayslips, input, options),
    /** GET /v1/hr/payroll/runs/:id/payslips/:employeeId/pdf */
    getV1HrPayrollRunsByIdPayslipsByEmployeeIdPdf: (
      input: { readonly path: { readonly employeeId: string; readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1HrPayrollRunsByIdPayslipsByEmployeeIdPdf, input, options),
    /** GET /v1/hr/payroll/runs/:id/preview */
    getV1HrPayrollRunsByIdPreview: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1HrPayrollRunsByIdPreview, input, options),
    /** GET /v1/hr/payroll/wallets */
    getV1HrPayrollWallets: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1HrPayrollWallets, undefined, options),
    /** GET /v1/hr/performance/me */
    getV1HrPerformanceMe: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1HrPerformanceMe, undefined, options),
    /** GET /v1/hr/productivity */
    getV1HrProductivity: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1HrProductivity, undefined, options),
    /** GET /v1/hr/targets */
    getV1HrTargets: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1HrTargets, undefined, options),
    /** GET /v1/hr/targets/:id */
    getV1HrTargetsById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.getV1HrTargetsById, input, options),
    /** GET /v1/intake/site-keys */
    getV1IntakeSiteKeys: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1IntakeSiteKeys, undefined, options),
    /** GET /v1/inventory/adjustments */
    getV1InventoryAdjustments: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1InventoryAdjustments, undefined, options),
    /** GET /v1/inventory/counts */
    getV1InventoryCounts: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1InventoryCounts, undefined, options),
    /** GET /v1/inventory/counts/:id */
    getV1InventoryCountsById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.getV1InventoryCountsById, input, options),
    /** GET /v1/inventory/locations */
    getV1InventoryLocations: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1InventoryLocations, undefined, options),
    /** GET /v1/inventory/movements */
    getV1InventoryMovements: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1InventoryMovements, undefined, options),
    /** GET /v1/inventory/reconciliations */
    getV1InventoryReconciliations: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1InventoryReconciliations, undefined, options),
    /** GET /v1/inventory/stock */
    getV1InventoryStock: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1InventoryStock, undefined, options),
    /** GET /v1/inventory/transfers */
    getV1InventoryTransfers: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1InventoryTransfers, undefined, options),
    /** GET /v1/inventory/valuation */
    getV1InventoryValuation: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1InventoryValuation, undefined, options),
    /** GET /v1/investors */
    getV1Investors: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1Investors, undefined, options),
    /** GET /v1/investors/:id */
    getV1InvestorsById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.getV1InvestorsById, input, options),
    /** GET /v1/investors/:id/statement */
    getV1InvestorsByIdStatement: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.getV1InvestorsByIdStatement, input, options),
    /** GET /v1/investors/distributions */
    getV1InvestorsDistributions: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1InvestorsDistributions, undefined, options),
    /** GET /v1/investors/distributions/:id */
    getV1InvestorsDistributionsById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1InvestorsDistributionsById, input, options),
    /** GET /v1/investors/documents */
    getV1InvestorsDocuments: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1InvestorsDocuments, undefined, options),
    /** GET /v1/investors/documents/:id/download */
    getV1InvestorsDocumentsByIdDownload: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1InvestorsDocumentsByIdDownload, input, options),
    /** GET /v1/investors/investments */
    getV1InvestorsInvestments: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1InvestorsInvestments, undefined, options),
    /** GET /v1/investors/wallet-accounts */
    getV1InvestorsWalletAccounts: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1InvestorsWalletAccounts, undefined, options),
    /** GET /v1/investors/withdrawals */
    getV1InvestorsWithdrawals: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1InvestorsWithdrawals, undefined, options),
    /** GET /v1/jobs/failed */
    getV1JobsFailed: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1JobsFailed, undefined, options),
    /** GET /v1/loans */
    getV1Loans: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1Loans, undefined, options),
    /** GET /v1/loans/:id */
    getV1LoansById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.getV1LoansById, input, options),
    /** GET /v1/loans/lenders */
    getV1LoansLenders: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1LoansLenders, undefined, options),
    /** GET /v1/marketing/campaigns */
    getV1MarketingCampaigns: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1MarketingCampaigns, undefined, options),
    /** GET /v1/marketing/capi-events */
    getV1MarketingCapiEvents: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1MarketingCapiEvents, undefined, options),
    /** GET /v1/marketing/dashboard */
    getV1MarketingDashboard: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1MarketingDashboard, undefined, options),
    /** GET /v1/marketing/leads */
    getV1MarketingLeads: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1MarketingLeads, undefined, options),
    /** GET /v1/marketing/leads/segments */
    getV1MarketingLeadsSegments: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1MarketingLeadsSegments, undefined, options),
    /** GET /v1/marketing/meta-connection */
    getV1MarketingMetaConnection: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1MarketingMetaConnection, undefined, options),
    /** GET /v1/marketing/spend */
    getV1MarketingSpend: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1MarketingSpend, undefined, options),
    /** GET /v1/marketing/spend/campaigns */
    getV1MarketingSpendCampaigns: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1MarketingSpendCampaigns, undefined, options),
    /** GET /v1/notify/messages */
    getV1NotifyMessages: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1NotifyMessages, undefined, options),
    /** GET /v1/notify/opt-outs */
    getV1NotifyOptOuts: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1NotifyOptOuts, undefined, options),
    /** GET /v1/notify/templates */
    getV1NotifyTemplates: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1NotifyTemplates, undefined, options),
    /** GET /v1/order-advances */
    getV1OrderAdvances: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1OrderAdvances, undefined, options),
    /** GET /v1/orders */
    getV1Orders: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1Orders, undefined, options),
    /** GET /v1/orders/agents */
    getV1OrdersAgents: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1OrdersAgents, undefined, options),
    /** GET /v1/orders/availability */
    getV1OrdersAvailability: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1OrdersAvailability, undefined, options),
    /** GET /v1/orders/:id */
    getV1OrdersById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.getV1OrdersById, input, options),
    /** GET /v1/orders/:id/advances */
    getV1OrdersByIdAdvances: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.getV1OrdersByIdAdvances, input, options),
    /** GET /v1/orders/:id/document */
    getV1OrdersByIdDocument: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.getV1OrdersByIdDocument, input, options),
    /** GET /v1/orders/documents */
    getV1OrdersDocuments: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1OrdersDocuments, undefined, options),
    /** GET /v1/orders/duplicates */
    getV1OrdersDuplicates: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1OrdersDuplicates, undefined, options),
    /** GET /v1/orders/return-reasons */
    getV1OrdersReturnReasons: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1OrdersReturnReasons, undefined, options),
    /** GET /v1/pos/branches */
    getV1PosBranches: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1PosBranches, undefined, options),
    /** GET /v1/pos/branches/:id/closings */
    getV1PosBranchesByIdClosings: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1PosBranchesByIdClosings, input, options),
    /** GET /v1/pos/branches/:id/summary */
    getV1PosBranchesByIdSummary: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.getV1PosBranchesByIdSummary, input, options),
    /** GET /v1/pos/receipts/:receiptNo */
    getV1PosReceiptsByReceiptNo: (
      input: { readonly path: { readonly receiptNo: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.getV1PosReceiptsByReceiptNo, input, options),
    /** GET /v1/pos/registers */
    getV1PosRegisters: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1PosRegisters, undefined, options),
    /** GET /v1/pos/registers/:id/price-list */
    getV1PosRegistersByIdPriceList: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1PosRegistersByIdPriceList, input, options),
    /** GET /v1/pos/registers/:id/session */
    getV1PosRegistersByIdSession: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1PosRegistersByIdSession, input, options),
    /** GET /v1/pos/reviews */
    getV1PosReviews: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1PosReviews, undefined, options),
    /** GET /v1/pos/sales/:id */
    getV1PosSalesById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.getV1PosSalesById, input, options),
    /** GET /v1/pos/shifts */
    getV1PosShifts: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1PosShifts, undefined, options),
    /** GET /v1/pos/shifts/:id */
    getV1PosShiftsById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.getV1PosShiftsById, input, options),
    /** GET /v1/promo/codes */
    getV1PromoCodes: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1PromoCodes, undefined, options),
    /** GET /v1/promo/codes/:id/redemptions */
    getV1PromoCodesByIdRedemptions: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1PromoCodesByIdRedemptions, input, options),
    /** GET /v1/supply/entries */
    getV1SupplyEntries: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1SupplyEntries, undefined, options),
    /** GET /v1/supply/entries/:id */
    getV1SupplyEntriesById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.getV1SupplyEntriesById, input, options),
    /** GET /v1/supply/payments */
    getV1SupplyPayments: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1SupplyPayments, undefined, options),
    /** GET /v1/supply/returns */
    getV1SupplyReturns: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1SupplyReturns, undefined, options),
    /** GET /v1/supply/suppliers */
    getV1SupplySuppliers: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1SupplySuppliers, undefined, options),
    /** GET /v1/supply/suppliers/:id */
    getV1SupplySuppliersById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.getV1SupplySuppliersById, input, options),
    /** GET /v1/supply/suppliers/:id/statement */
    getV1SupplySuppliersByIdStatement: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1SupplySuppliersByIdStatement, input, options),
    /** Liveness probe. */
    healthLive: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.healthLive, undefined, options),
    /** Readiness probe. */
    healthReady: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.healthReady, undefined, options),
    /** Approval requests, filtered and cursor-paginated. */
    listApprovals: (
      input: {
        readonly query?: {
          readonly cursor?: string;
          readonly limit?: string;
          readonly status?: string;
          readonly type?: string;
        };
      },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.listApprovals, input, options),
    /** Test fixture for the permission matrix. Not deployed to production. */
    listDemoCostedItems: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.listDemoCostedItems, undefined, options),
    /** The chart of accounts visible to this caller. */
    listLedgerAccounts: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.listLedgerAccounts, undefined, options),
    /** The organizations this user may enter. */
    listMyOrgs: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.listMyOrgs, undefined, options),
    /** Accounting periods and whether each is closed. */
    listPeriods: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.listPeriods, undefined, options),
    /** This organization's staff, their roles and sign-in state, and open resets. */
    listUsers: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.listUsers, undefined, options),
    /** Cash, bank and mobile-money wallets with their balances. */
    listWallets: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.listWallets, undefined, options),
    /** The brand name and logo for the login screen, chosen by hostname. */
    loginBranding: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.loginBranding, undefined, options),
    /** The signed-in user, their roles and active org. */
    me: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.me, undefined, options),
    /** Outstanding balances per customer, supplier or reseller. */
    partyBalances: (
      input: {
        readonly query: {
          readonly asOf: string;
          readonly partyId?: string;
          readonly partyType?: string;
        };
      },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.partyBalances, input, options),
    /** PATCH /v1/accounts/wallets/:id */
    patchV1AccountsWalletsById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.patchV1AccountsWalletsById, input, options),
    /** PATCH /v1/catalog/categories/:id */
    patchV1CatalogCategoriesById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.patchV1CatalogCategoriesById, input, options),
    /** PATCH /v1/catalog/products/:id */
    patchV1CatalogProductsById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.patchV1CatalogProductsById, input, options),
    /** PATCH /v1/customers/:id */
    patchV1CustomersById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.patchV1CustomersById, input, options),
    /** PATCH /v1/hr/employees/:id */
    patchV1HrEmployeesById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.patchV1HrEmployeesById, input, options),
    /** PATCH /v1/inventory/locations/:id */
    patchV1InventoryLocationsById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.patchV1InventoryLocationsById, input, options),
    /** PATCH /v1/investors/:id */
    patchV1InvestorsById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.patchV1InvestorsById, input, options),
    /** PATCH /v1/marketing/campaigns/:id */
    patchV1MarketingCampaignsById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.patchV1MarketingCampaignsById, input, options),
    /** PATCH /v1/marketing/leads/:id */
    patchV1MarketingLeadsById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.patchV1MarketingLeadsById, input, options),
    /** PATCH /v1/orders/:id */
    patchV1OrdersById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.patchV1OrdersById, input, options),
    /** PATCH /v1/pos/registers/:id */
    patchV1PosRegistersById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.patchV1PosRegistersById, input, options),
    /** PATCH /v1/promo/codes/:id */
    patchV1PromoCodesById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.patchV1PromoCodesById, input, options),
    /** PATCH /v1/supply/drafts/:id */
    patchV1SupplyDraftsById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.patchV1SupplyDraftsById, input, options),
    /** PATCH /v1/supply/suppliers/:id */
    patchV1SupplySuppliersById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.patchV1SupplySuppliersById, input, options),
    /** POST /public/v1/orders */
    postPublicV1Orders: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postPublicV1Orders, undefined, options),
    /** POST /v1/accounts/cash-entries */
    postV1AccountsCashEntries: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1AccountsCashEntries, undefined, options),
    /** POST /v1/accounts/closings */
    postV1AccountsClosings: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1AccountsClosings, undefined, options),
    /** POST /v1/accounts/transfers */
    postV1AccountsTransfers: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1AccountsTransfers, undefined, options),
    /** POST /v1/accounts/wallets */
    postV1AccountsWallets: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1AccountsWallets, undefined, options),
    /** POST /v1/analytics/rollups/refresh */
    postV1AnalyticsRollupsRefresh: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1AnalyticsRollupsRefresh, undefined, options),
    /** POST /v1/catalog/attributes */
    postV1CatalogAttributes: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1CatalogAttributes, undefined, options),
    /** POST /v1/catalog/attributes/:id/values */
    postV1CatalogAttributesByIdValues: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1CatalogAttributesByIdValues, input, options),
    /** POST /v1/catalog/categories */
    postV1CatalogCategories: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1CatalogCategories, undefined, options),
    /** POST /v1/catalog/imports/prices */
    postV1CatalogImportsPrices: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1CatalogImportsPrices, undefined, options),
    /** POST /v1/catalog/imports/prices/dry-run */
    postV1CatalogImportsPricesDryRun: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1CatalogImportsPricesDryRun, undefined, options),
    /** POST /v1/catalog/labels */
    postV1CatalogLabels: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1CatalogLabels, undefined, options),
    /** POST /v1/catalog/products */
    postV1CatalogProducts: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1CatalogProducts, undefined, options),
    /** POST /v1/catalog/products/:id/images */
    postV1CatalogProductsByIdImages: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1CatalogProductsByIdImages, input, options),
    /** POST /v1/catalog/products/:id/variants */
    postV1CatalogProductsByIdVariants: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1CatalogProductsByIdVariants, input, options),
    /** POST /v1/courier/accounts */
    postV1CourierAccounts: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1CourierAccounts, undefined, options),
    /** POST /v1/courier/parcels */
    postV1CourierParcels: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1CourierParcels, undefined, options),
    /** POST /v1/courier/parcels/bulk */
    postV1CourierParcelsBulk: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1CourierParcelsBulk, undefined, options),
    /** POST /v1/courier/parcels/:id/escalations */
    postV1CourierParcelsByIdEscalations: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1CourierParcelsByIdEscalations, input, options),
    /** POST /v1/courier/parcels/:id/handover */
    postV1CourierParcelsByIdHandover: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1CourierParcelsByIdHandover, input, options),
    /** POST /v1/courier/parcels/:id/receive-return */
    postV1CourierParcelsByIdReceiveReturn: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1CourierParcelsByIdReceiveReturn, input, options),
    /** POST /v1/courier/parcels/:id/status */
    postV1CourierParcelsByIdStatus: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1CourierParcelsByIdStatus, input, options),
    /** POST /v1/courier/settlements */
    postV1CourierSettlements: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1CourierSettlements, undefined, options),
    /** POST /v1/courier/settlements/:id/approval */
    postV1CourierSettlementsByIdApproval: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1CourierSettlementsByIdApproval, input, options),
    /** POST /v1/courier/settlements/:id/reject */
    postV1CourierSettlementsByIdReject: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1CourierSettlementsByIdReject, input, options),
    /** POST /v1/courier/settlements/fetch */
    postV1CourierSettlementsFetch: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1CourierSettlementsFetch, undefined, options),
    /** POST /v1/courier/stuck/repoll */
    postV1CourierStuckRepoll: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1CourierStuckRepoll, undefined, options),
    /** POST /v1/courier/webhooks/:orgId/:provider */
    postV1CourierWebhooksByOrgIdByProvider: (
      input: { readonly path: { readonly orgId: string; readonly provider: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1CourierWebhooksByOrgIdByProvider, input, options),
    /** POST /v1/customers */
    postV1Customers: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1Customers, undefined, options),
    /** POST /v1/files */
    postV1Files: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1Files, undefined, options),
    /** POST /v1/files/:id/finalize */
    postV1FilesByIdFinalize: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.postV1FilesByIdFinalize, input, options),
    /** POST /v1/hr/attendance/imports */
    postV1HrAttendanceImports: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1HrAttendanceImports, undefined, options),
    /** POST /v1/hr/bonus-rules */
    postV1HrBonusRules: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1HrBonusRules, undefined, options),
    /** POST /v1/hr/bonus-rules/:id/versions */
    postV1HrBonusRulesByIdVersions: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1HrBonusRulesByIdVersions, input, options),
    /** POST /v1/hr/bonus-rules/versions/:versionId/submit */
    postV1HrBonusRulesVersionsByVersionIdSubmit: (
      input: { readonly path: { readonly versionId: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1HrBonusRulesVersionsByVersionIdSubmit, input, options),
    /** POST /v1/hr/calendars */
    postV1HrCalendars: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1HrCalendars, undefined, options),
    /** POST /v1/hr/calendars/:id/holidays */
    postV1HrCalendarsByIdHolidays: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1HrCalendarsByIdHolidays, input, options),
    /** POST /v1/hr/employees */
    postV1HrEmployees: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1HrEmployees, undefined, options),
    /** POST /v1/hr/employees/:id/salary */
    postV1HrEmployeesByIdSalary: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.postV1HrEmployeesByIdSalary, input, options),
    /** POST /v1/hr/loans */
    postV1HrLoans: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1HrLoans, undefined, options),
    /** POST /v1/hr/loans/:id/disburse */
    postV1HrLoansByIdDisburse: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.postV1HrLoansByIdDisburse, input, options),
    /** POST /v1/hr/payroll/runs */
    postV1HrPayrollRuns: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1HrPayrollRuns, undefined, options),
    /** POST /v1/hr/payroll/runs/:id/bonuses */
    postV1HrPayrollRunsByIdBonuses: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1HrPayrollRunsByIdBonuses, input, options),
    /** POST /v1/hr/payroll/runs/:id/cancel */
    postV1HrPayrollRunsByIdCancel: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1HrPayrollRunsByIdCancel, input, options),
    /** POST /v1/hr/payroll/runs/:id/inputs */
    postV1HrPayrollRunsByIdInputs: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1HrPayrollRunsByIdInputs, input, options),
    /** POST /v1/hr/payroll/runs/:id/pay */
    postV1HrPayrollRunsByIdPay: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.postV1HrPayrollRunsByIdPay, input, options),
    /** POST /v1/hr/payroll/runs/:id/submit */
    postV1HrPayrollRunsByIdSubmit: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1HrPayrollRunsByIdSubmit, input, options),
    /** POST /v1/hr/targets */
    postV1HrTargets: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1HrTargets, undefined, options),
    /** POST /v1/hr/targets/:id/cancel */
    postV1HrTargetsByIdCancel: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.postV1HrTargetsByIdCancel, input, options),
    /** POST /v1/hr/targets/refresh */
    postV1HrTargetsRefresh: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1HrTargetsRefresh, undefined, options),
    /** POST /v1/intake/site-keys */
    postV1IntakeSiteKeys: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1IntakeSiteKeys, undefined, options),
    /** POST /v1/intake/site-keys/:id/revoke */
    postV1IntakeSiteKeysByIdRevoke: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1IntakeSiteKeysByIdRevoke, input, options),
    /** POST /v1/inventory/adjustments */
    postV1InventoryAdjustments: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1InventoryAdjustments, undefined, options),
    /** POST /v1/inventory/counts */
    postV1InventoryCounts: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1InventoryCounts, undefined, options),
    /** POST /v1/inventory/counts/:id/close */
    postV1InventoryCountsByIdClose: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1InventoryCountsByIdClose, input, options),
    /** POST /v1/inventory/counts/:id/submit */
    postV1InventoryCountsByIdSubmit: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1InventoryCountsByIdSubmit, input, options),
    /** POST /v1/inventory/locations */
    postV1InventoryLocations: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1InventoryLocations, undefined, options),
    /** POST /v1/inventory/transfers */
    postV1InventoryTransfers: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1InventoryTransfers, undefined, options),
    /** POST /v1/inventory/transfers/:id/receive */
    postV1InventoryTransfersByIdReceive: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1InventoryTransfersByIdReceive, input, options),
    /** POST /v1/investors */
    postV1Investors: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1Investors, undefined, options),
    /** POST /v1/investors/distributions */
    postV1InvestorsDistributions: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1InvestorsDistributions, undefined, options),
    /** POST /v1/investors/distributions/:id/reject */
    postV1InvestorsDistributionsByIdReject: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1InvestorsDistributionsByIdReject, input, options),
    /** POST /v1/investors/documents */
    postV1InvestorsDocuments: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1InvestorsDocuments, undefined, options),
    /** POST /v1/investors/investments */
    postV1InvestorsInvestments: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1InvestorsInvestments, undefined, options),
    /** POST /v1/investors/withdrawals */
    postV1InvestorsWithdrawals: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1InvestorsWithdrawals, undefined, options),
    /** POST /v1/investors/withdrawals/:id/pay */
    postV1InvestorsWithdrawalsByIdPay: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1InvestorsWithdrawalsByIdPay, input, options),
    /** POST /v1/investors/withdrawals/:id/reject */
    postV1InvestorsWithdrawalsByIdReject: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1InvestorsWithdrawalsByIdReject, input, options),
    /** POST /v1/investors/withdrawals/:id/review */
    postV1InvestorsWithdrawalsByIdReview: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1InvestorsWithdrawalsByIdReview, input, options),
    /** POST /v1/loans */
    postV1Loans: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1Loans, undefined, options),
    /** POST /v1/loans/:id/payments */
    postV1LoansByIdPayments: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.postV1LoansByIdPayments, input, options),
    /** POST /v1/loans/:id/void */
    postV1LoansByIdVoid: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.postV1LoansByIdVoid, input, options),
    /** POST /v1/loans/lenders */
    postV1LoansLenders: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1LoansLenders, undefined, options),
    /** POST /v1/loans/preview */
    postV1LoansPreview: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1LoansPreview, undefined, options),
    /** POST /v1/marketing/campaigns */
    postV1MarketingCampaigns: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1MarketingCampaigns, undefined, options),
    /** POST /v1/marketing/campaigns/:id/refs */
    postV1MarketingCampaignsByIdRefs: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1MarketingCampaignsByIdRefs, input, options),
    /** POST /v1/marketing/leads */
    postV1MarketingLeads: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1MarketingLeads, undefined, options),
    /** POST /v1/marketing/meta/import */
    postV1MarketingMetaImport: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1MarketingMetaImport, undefined, options),
    /** POST /v1/notify/opt-outs */
    postV1NotifyOptOuts: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1NotifyOptOuts, undefined, options),
    /** POST /v1/order-advances/:id/refund */
    postV1OrderAdvancesByIdRefund: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1OrderAdvancesByIdRefund, input, options),
    /** POST /v1/order-advances/:id/reject */
    postV1OrderAdvancesByIdReject: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1OrderAdvancesByIdReject, input, options),
    /** POST /v1/order-advances/:id/verify */
    postV1OrderAdvancesByIdVerify: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1OrderAdvancesByIdVerify, input, options),
    /** POST /v1/order-advances/:id/void */
    postV1OrderAdvancesByIdVoid: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.postV1OrderAdvancesByIdVoid, input, options),
    /** POST /v1/orders */
    postV1Orders: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1Orders, undefined, options),
    /** POST /v1/orders/bulk-confirm */
    postV1OrdersBulkConfirm: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1OrdersBulkConfirm, undefined, options),
    /** POST /v1/orders/bulk-transition */
    postV1OrdersBulkTransition: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1OrdersBulkTransition, undefined, options),
    /** POST /v1/orders/:id/advances */
    postV1OrdersByIdAdvances: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.postV1OrdersByIdAdvances, input, options),
    /** POST /v1/orders/:id/assign */
    postV1OrdersByIdAssign: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.postV1OrdersByIdAssign, input, options),
    /** POST /v1/orders/:id/cancel */
    postV1OrdersByIdCancel: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.postV1OrdersByIdCancel, input, options),
    /** POST /v1/orders/:id/claim */
    postV1OrdersByIdClaim: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.postV1OrdersByIdClaim, input, options),
    /** POST /v1/orders/:id/confirm */
    postV1OrdersByIdConfirm: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.postV1OrdersByIdConfirm, input, options),
    /** POST /v1/orders/:id/deliver */
    postV1OrdersByIdDeliver: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.postV1OrdersByIdDeliver, input, options),
    /** POST /v1/orders/:id/exchange */
    postV1OrdersByIdExchange: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.postV1OrdersByIdExchange, input, options),
    /** POST /v1/orders/:id/hold */
    postV1OrdersByIdHold: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.postV1OrdersByIdHold, input, options),
    /** POST /v1/orders/:id/pack */
    postV1OrdersByIdPack: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.postV1OrdersByIdPack, input, options),
    /** POST /v1/orders/:id/partial-delivery */
    postV1OrdersByIdPartialDelivery: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1OrdersByIdPartialDelivery, input, options),
    /** POST /v1/orders/:id/receive-return */
    postV1OrdersByIdReceiveReturn: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1OrdersByIdReceiveReturn, input, options),
    /** POST /v1/orders/:id/release-hold */
    postV1OrdersByIdReleaseHold: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.postV1OrdersByIdReleaseHold, input, options),
    /** POST /v1/orders/:id/ship */
    postV1OrdersByIdShip: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.postV1OrdersByIdShip, input, options),
    /** POST /v1/orders/:id/start-return */
    postV1OrdersByIdStartReturn: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.postV1OrdersByIdStartReturn, input, options),
    /** POST /v1/pos/branches/:id/closings */
    postV1PosBranchesByIdClosings: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1PosBranchesByIdClosings, input, options),
    /** POST /v1/pos/promo-codes/check */
    postV1PosPromoCodesCheck: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1PosPromoCodesCheck, undefined, options),
    /** POST /v1/pos/registers */
    postV1PosRegisters: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1PosRegisters, undefined, options),
    /** POST /v1/pos/reviews/:id/resolve */
    postV1PosReviewsByIdResolve: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.postV1PosReviewsByIdResolve, input, options),
    /** POST /v1/pos/shifts */
    postV1PosShifts: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1PosShifts, undefined, options),
    /** POST /v1/pos/shifts/:id/close */
    postV1PosShiftsByIdClose: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.postV1PosShiftsByIdClose, input, options),
    /** POST /v1/pos/sync */
    postV1PosSync: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1PosSync, undefined, options),
    /** POST /v1/promo/check */
    postV1PromoCheck: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1PromoCheck, undefined, options),
    /** POST /v1/promo/codes */
    postV1PromoCodes: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1PromoCodes, undefined, options),
    /** POST /v1/supply/advance-applications */
    postV1SupplyAdvanceApplications: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1SupplyAdvanceApplications, undefined, options),
    /** POST /v1/supply/drafts */
    postV1SupplyDrafts: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1SupplyDrafts, undefined, options),
    /** POST /v1/supply/entries */
    postV1SupplyEntries: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1SupplyEntries, undefined, options),
    /** POST /v1/supply/entries/:id/receive */
    postV1SupplyEntriesByIdReceive: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1SupplyEntriesByIdReceive, input, options),
    /** POST /v1/supply/payments */
    postV1SupplyPayments: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1SupplyPayments, undefined, options),
    /** POST /v1/supply/returns */
    postV1SupplyReturns: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1SupplyReturns, undefined, options),
    /** POST /v1/supply/suppliers */
    postV1SupplySuppliers: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1SupplySuppliers, undefined, options),
    /** POST /v1/supply/suppliers/:id/contacts */
    postV1SupplySuppliersByIdContacts: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1SupplySuppliersByIdContacts, input, options),
    /** POST /v1/supply/suppliers/:id/documents */
    postV1SupplySuppliersByIdDocuments: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1SupplySuppliersByIdDocuments, input, options),
    /** POST /v1/supply/suppliers/:id/notes */
    postV1SupplySuppliersByIdNotes: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1SupplySuppliersByIdNotes, input, options),
    /** POST /v1/track */
    postV1Track: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1Track, undefined, options),
    /** PUT /v1/catalog/prices */
    putV1CatalogPrices: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.putV1CatalogPrices, undefined, options),
    /** PUT /v1/catalog/products/:id/images/order */
    putV1CatalogProductsByIdImagesOrder: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.putV1CatalogProductsByIdImagesOrder, input, options),
    /** PUT /v1/catalog/skus/:id/barcode */
    putV1CatalogSkusByIdBarcode: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.putV1CatalogSkusByIdBarcode, input, options),
    /** PUT /v1/courier/selection-rules */
    putV1CourierSelectionRules: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.putV1CourierSelectionRules, undefined, options),
    /** PUT /v1/delivery-zones */
    putV1DeliveryZones: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.putV1DeliveryZones, undefined, options),
    /** PUT /v1/files/content */
    putV1FilesContent: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.putV1FilesContent, undefined, options),
    /** PUT /v1/hr/attendance */
    putV1HrAttendance: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.putV1HrAttendance, undefined, options),
    /** PUT /v1/inventory/counts/:id/lines */
    putV1InventoryCountsByIdLines: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.putV1InventoryCountsByIdLines, input, options),
    /** PUT /v1/inventory/reorder-levels */
    putV1InventoryReorderLevels: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.putV1InventoryReorderLevels, undefined, options),
    /** PUT /v1/marketing/meta-connection */
    putV1MarketingMetaConnection: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.putV1MarketingMetaConnection, undefined, options),
    /** PUT /v1/marketing/spend */
    putV1MarketingSpend: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.putV1MarketingSpend, undefined, options),
    /** PUT /v1/notify/templates */
    putV1NotifyTemplates: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.putV1NotifyTemplates, undefined, options),
    /** Ask to reopen a closed month. Needs an approval. */
    reopenPeriod: (
      input: { readonly body: ReopenPeriodInput },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.reopenPeriod, input, options),
    /** Remove a person's second factor, so they enrol again at next sign-in. */
    resetUserTwoFactor: (
      input: { readonly path: { readonly id: string }; readonly body: CredentialResetInput },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.resetUserTwoFactor, input, options),
    /** Set this organization's maker-checker thresholds. */
    setApprovalThresholds: (
      input: { readonly body: ThresholdInput },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.setApprovalThresholds, input, options),
    /** Replace a person's roles and branch scope in this organization. */
    setUserRoles: (
      input: { readonly path: { readonly id: string }; readonly body: SetRoles },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.setUserRoles, input, options),
    /** Enter an organization for the rest of this session. */
    switchOrg: (input: { readonly body: SwitchOrg }, options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.switchOrg, input, options),
    /** Debit and credit totals per account as of a business date. */
    trialBalance: (
      input: { readonly query: { readonly asOf: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.trialBalance, input, options),
    /** Issue, ask for, or collect a one-time link that sets a password. */
    userPasswordLink: (
      input: { readonly path: { readonly id: string }; readonly body: CredentialResetInput },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.userPasswordLink, input, options),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
