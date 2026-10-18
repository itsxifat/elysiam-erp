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
  CallAttemptInput,
  CallerPanelQuery,
  CashInInput,
  ClosePeriodInput,
  ConfirmWithCode,
  CreateUser,
  CredentialResetInput,
  CustomerPinnedNoteInput,
  DeactivateUser,
  DeskProfileInput,
  InboxAddressInput,
  InboxChannelUpdateInput,
  InboxHandOverInput,
  InboxInterestInput,
  InboxMetaAppInput,
  InboxNoteInput,
  InboxPhoneInput,
  InboxReplyInput,
  InboxStageInput,
  InboxTagsInput,
  MarkPrintedInput,
  PackingCameraCreateInput,
  PackingCameraUpdateInput,
  PhoneCallAnsweredInput,
  PhoneCallPlaceInput,
  PhoneCallWrapUpInput,
  PresenceBeat,
  PresencePause,
  ReopenPeriodInput,
  ReplacementCode,
  SavedReplyInput,
  SetRoles,
  SwitchOrg,
  TelephonyAssignInput,
  TelephonyConnectionCreateInput,
  TelephonyConnectionUpdateInput,
  ThresholdInput,
  TwoFactorPolicyInput,
  UpdateProfile,
  WorkflowSettingsInput,
} from '@elysium/contracts';

import { request, type ApiRuntime, type RequestOptions } from '../runtime.js';

/** Every operation, with the ability its route declares (§6). */
export const OPERATIONS = {
  acceptOrderOffer: {
    method: 'POST',
    path: '/v1/orders/offers/{id}/accept',
    ability: 'update:Order',
  },
  accountLedger: {
    method: 'GET',
    path: '/v1/ledger/accounts/{id}/ledger',
    ability: 'read:LedgerReport',
  },
  addInboxInterest: {
    method: 'POST',
    path: '/v1/inbox/conversations/{id}/interests',
    ability: 'update:Conversation',
  },
  addInboxNote: {
    method: 'POST',
    path: '/v1/inbox/conversations/{id}/notes',
    ability: 'update:Conversation',
  },
  addPackingCamera: { method: 'POST', path: '/v1/packing/cameras', ability: 'update:PackingVideo' },
  answeredPhoneCall: {
    method: 'POST',
    path: '/v1/telephony/calls/answered',
    ability: 'create:PhoneCall',
  },
  assignTelephonyExtension: {
    method: 'PUT',
    path: '/v1/telephony/connections/{id}/extensions/{extension}',
    ability: 'update:PhoneExtension',
  },
  cashBook: { method: 'GET', path: '/v1/ledger/wallets/{id}/cash-book', ability: 'read:Wallet' },
  cashIn: { method: 'POST', path: '/v1/ledger/cash-in', ability: 'update:Wallet' },
  closeInboxConversation: {
    method: 'POST',
    path: '/v1/inbox/conversations/{id}/close',
    ability: 'update:Conversation',
  },
  closePeriod: { method: 'POST', path: '/v1/ledger/periods/close', ability: 'update:LedgerPeriod' },
  confirmTwoFactorReplacement: {
    method: 'POST',
    path: '/v1/account/two-factor/replace/confirm',
    ability: 'authenticated',
  },
  countSavedReplyUse: {
    method: 'POST',
    path: '/v1/inbox/saved-replies/{id}/use',
    ability: 'read:SavedReply',
  },
  createApproval: { method: 'POST', path: '/v1/approvals', ability: 'request:ApprovalRequest' },
  createDemoCostedItem: {
    method: 'POST',
    path: '/v1/demo/costed-items',
    ability: 'create:CostedItem',
  },
  createSavedReply: {
    method: 'POST',
    path: '/v1/inbox/saved-replies',
    ability: 'create:SavedReply',
  },
  createTelephonyConnection: {
    method: 'POST',
    path: '/v1/telephony/connections',
    ability: 'create:Telephony',
  },
  createUser: { method: 'POST', path: '/v1/users', ability: 'create:User' },
  dayBook: { method: 'GET', path: '/v1/ledger/day-book', ability: 'read:LedgerReport' },
  deactivateUser: { method: 'POST', path: '/v1/users/{id}/deactivate', ability: 'update:User' },
  decideApproval: {
    method: 'POST',
    path: '/v1/approvals/{id}/decide',
    ability: 'approve:ApprovalRequest',
  },
  declineOrderOffer: {
    method: 'POST',
    path: '/v1/orders/offers/{id}/decline',
    ability: 'update:Order',
  },
  deletePackingCamera: {
    method: 'DELETE',
    path: '/v1/packing/cameras/{id}',
    ability: 'update:PackingVideo',
  },
  deleteSavedReply: {
    method: 'DELETE',
    path: '/v1/inbox/saved-replies/{id}',
    ability: 'delete:SavedReply',
  },
  deleteV1CatalogAttributesById: {
    method: 'DELETE',
    path: '/v1/catalog/attributes/{id}',
    ability: 'delete:Catalog',
  },
  deleteV1CatalogAttributesByIdValuesByValueId: {
    method: 'DELETE',
    path: '/v1/catalog/attributes/{id}/values/{valueId}',
    ability: 'delete:Catalog',
  },
  deleteV1CatalogCategoriesById: {
    method: 'DELETE',
    path: '/v1/catalog/categories/{id}',
    ability: 'delete:Catalog',
  },
  deleteV1CatalogProductsById: {
    method: 'DELETE',
    path: '/v1/catalog/products/{id}',
    ability: 'delete:Catalog',
  },
  deleteV1CatalogProductsByIdImagesByImageId: {
    method: 'DELETE',
    path: '/v1/catalog/products/{id}/images/{imageId}',
    ability: 'update:Catalog',
  },
  deleteV1CatalogSkusById: {
    method: 'DELETE',
    path: '/v1/catalog/skus/{id}',
    ability: 'delete:Catalog',
  },
  deleteV1HrPayrollRunsByIdInputsByInputId: {
    method: 'DELETE',
    path: '/v1/hr/payroll/runs/{id}/inputs/{inputId}',
    ability: 'create:Payroll',
  },
  deleteV1InventoryLocationsById: {
    method: 'DELETE',
    path: '/v1/inventory/locations/{id}',
    ability: 'delete:Catalog',
  },
  deleteV1InventoryStockInHandDraftsById: {
    method: 'DELETE',
    path: '/v1/inventory/stock-in-hand/drafts/{id}',
    ability: 'update:Supply',
  },
  deleteV1LabelsPrintersById: {
    method: 'DELETE',
    path: '/v1/labels/printers/{id}',
    ability: 'update:PackingTerminal',
  },
  deleteV1MarketingCampaignsById: {
    method: 'DELETE',
    path: '/v1/marketing/campaigns/{id}',
    ability: 'delete:Campaign',
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
  deleteV1NotifyTemplatesById: {
    method: 'DELETE',
    path: '/v1/notify/templates/{id}',
    ability: 'delete:Campaign',
  },
  deleteV1PromoCodesById: {
    method: 'DELETE',
    path: '/v1/promo/codes/{id}',
    ability: 'delete:LandingPage',
  },
  deleteV1PromoFlashSalesById: {
    method: 'DELETE',
    path: '/v1/promo/flash-sales/{id}',
    ability: 'delete:LandingPage',
  },
  deleteV1StorefrontCampaignLinksById: {
    method: 'DELETE',
    path: '/v1/storefront/campaign-links/{id}',
    ability: 'delete:Storefront',
  },
  deleteV1StorefrontHeroSlidesById: {
    method: 'DELETE',
    path: '/v1/storefront/hero-slides/{id}',
    ability: 'delete:Storefront',
  },
  deleteV1StorefrontNavItemsById: {
    method: 'DELETE',
    path: '/v1/storefront/nav-items/{id}',
    ability: 'delete:Storefront',
  },
  deleteV1StorefrontSizeChartsById: {
    method: 'DELETE',
    path: '/v1/storefront/size-charts/{id}',
    ability: 'delete:Storefront',
  },
  deleteV1SupplyDraftsById: {
    method: 'DELETE',
    path: '/v1/supply/drafts/{id}',
    ability: 'update:Supply',
  },
  deleteV1SupplySuppliersById: {
    method: 'DELETE',
    path: '/v1/supply/suppliers/{id}',
    ability: 'delete:Supply',
  },
  deleteV1TelephonyConnectionsByIdExtensionsByExtension: {
    method: 'DELETE',
    path: '/v1/telephony/connections/{id}/extensions/{extension}',
    ability: 'update:PhoneExtension',
  },
  endMyOtherSessions: {
    method: 'POST',
    path: '/v1/account/sessions/sign-out-others',
    ability: 'authenticated',
  },
  endMySession: { method: 'DELETE', path: '/v1/account/sessions/{id}', ability: 'authenticated' },
  getApiAdminScannerShipment: {
    method: 'GET',
    path: '/api/admin/scanner/shipment',
    ability: 'public',
  },
  getApproval: { method: 'GET', path: '/v1/approvals/{id}', ability: 'read:ApprovalRequest' },
  getInboxConversation: {
    method: 'GET',
    path: '/v1/inbox/conversations/{id}',
    ability: 'read:Conversation',
  },
  getInboxOrderDraft: {
    method: 'GET',
    path: '/v1/inbox/conversations/{id}/order-draft',
    ability: 'read:Conversation',
  },
  getInboxPanel: {
    method: 'GET',
    path: '/v1/inbox/conversations/{id}/panel',
    ability: 'read:Conversation',
  },
  getInboxPhoneFlags: {
    method: 'GET',
    path: '/v1/inbox/phone-flags',
    ability: 'read:Conversation',
  },
  getMediaByOrgIdByFileIdByVariant: {
    method: 'GET',
    path: '/media/{orgId}/{fileId}/{variant}',
    ability: 'public',
  },
  getMyAccount: { method: 'GET', path: '/v1/account', ability: 'authenticated' },
  getMyDesk: { method: 'GET', path: '/v1/team/me', ability: 'read:Presence' },
  getNcomByOrgIdV1: { method: 'GET', path: '/ncom/{orgId}/v1', ability: 'public' },
  getNcomByOrgIdV1Categories: {
    method: 'GET',
    path: '/ncom/{orgId}/v1/categories',
    ability: 'public',
  },
  getNcomByOrgIdV1Ping: { method: 'GET', path: '/ncom/{orgId}/v1/ping', ability: 'public' },
  getNcomByOrgIdV1Products: { method: 'GET', path: '/ncom/{orgId}/v1/products', ability: 'public' },
  getNcomByOrgIdV1ProductsById: {
    method: 'GET',
    path: '/ncom/{orgId}/v1/products/{id}',
    ability: 'public',
  },
  getStorefrontV1AccountsById: {
    method: 'GET',
    path: '/storefront/v1/accounts/{id}',
    ability: 'public',
  },
  getStorefrontV1AccountsByIdOrders: {
    method: 'GET',
    path: '/storefront/v1/accounts/{id}/orders',
    ability: 'public',
  },
  getStorefrontV1AccountsByIdOrdersByOrderNo: {
    method: 'GET',
    path: '/storefront/v1/accounts/{id}/orders/{orderNo}',
    ability: 'public',
  },
  getStorefrontV1CatalogCategories: {
    method: 'GET',
    path: '/storefront/v1/catalog/categories',
    ability: 'public',
  },
  getStorefrontV1CatalogProducts: {
    method: 'GET',
    path: '/storefront/v1/catalog/products',
    ability: 'public',
  },
  getStorefrontV1CatalogProductsBySlug: {
    method: 'GET',
    path: '/storefront/v1/catalog/products/{slug}',
    ability: 'public',
  },
  getStorefrontV1CatalogSearch: {
    method: 'GET',
    path: '/storefront/v1/catalog/search',
    ability: 'public',
  },
  getStorefrontV1CustomLinksByCode: {
    method: 'GET',
    path: '/storefront/v1/custom-links/{code}',
    ability: 'public',
  },
  getStorefrontV1FlashSales: {
    method: 'GET',
    path: '/storefront/v1/flash-sales',
    ability: 'public',
  },
  getStorefrontV1FlashSalesBySlug: {
    method: 'GET',
    path: '/storefront/v1/flash-sales/{slug}',
    ability: 'public',
  },
  getStorefrontV1GeoDistricts: {
    method: 'GET',
    path: '/storefront/v1/geo/districts',
    ability: 'public',
  },
  getStorefrontV1GeoThanas: { method: 'GET', path: '/storefront/v1/geo/thanas', ability: 'public' },
  getStorefrontV1OrdersByOrderNo: {
    method: 'GET',
    path: '/storefront/v1/orders/{orderNo}',
    ability: 'public',
  },
  getStorefrontV1Site: { method: 'GET', path: '/storefront/v1/site', ability: 'public' },
  getStorefrontV1SizeChartsById: {
    method: 'GET',
    path: '/storefront/v1/size-charts/{id}',
    ability: 'public',
  },
  getStorefrontV1TrackingConfig: {
    method: 'GET',
    path: '/storefront/v1/tracking/config',
    ability: 'public',
  },
  getTwoFactorPolicy: {
    method: 'GET',
    path: '/v1/security/two-factor-policy',
    ability: 'read:SecurityPolicy',
  },
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
  getV1AccountsHeads: { method: 'GET', path: '/v1/accounts/heads', ability: 'update:Wallet' },
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
  getV1AccountsReportsProfitAndLoss: {
    method: 'GET',
    path: '/v1/accounts/reports/profit-and-loss',
    ability: 'read:LedgerReport',
  },
  getV1AccountsWallets: { method: 'GET', path: '/v1/accounts/wallets', ability: 'read:Wallet' },
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
  getV1CatalogAttributesByIdUsage: {
    method: 'GET',
    path: '/v1/catalog/attributes/{id}/usage',
    ability: 'update:Catalog',
  },
  getV1CatalogAttributesByIdValuesByValueIdUsage: {
    method: 'GET',
    path: '/v1/catalog/attributes/{id}/values/{valueId}/usage',
    ability: 'update:Catalog',
  },
  getV1CatalogCategories: {
    method: 'GET',
    path: '/v1/catalog/categories',
    ability: 'read:Catalog',
  },
  getV1CatalogCategoriesByIdUsage: {
    method: 'GET',
    path: '/v1/catalog/categories/{id}/usage',
    ability: 'update:Catalog',
  },
  getV1CatalogLookup: { method: 'GET', path: '/v1/catalog/lookup', ability: 'read:Catalog' },
  getV1CatalogProducts: { method: 'GET', path: '/v1/catalog/products', ability: 'read:Catalog' },
  getV1CatalogProductsById: {
    method: 'GET',
    path: '/v1/catalog/products/{id}',
    ability: 'read:Catalog',
  },
  getV1CatalogProductsByIdPriceHistory: {
    method: 'GET',
    path: '/v1/catalog/products/{id}/price-history',
    ability: 'read:Catalog',
  },
  getV1CatalogProductsByIdUsage: {
    method: 'GET',
    path: '/v1/catalog/products/{id}/usage',
    ability: 'update:Catalog',
  },
  getV1CatalogSkus: { method: 'GET', path: '/v1/catalog/skus', ability: 'read:Catalog' },
  getV1CatalogSkusByIdPriceHistory: {
    method: 'GET',
    path: '/v1/catalog/skus/{id}/price-history',
    ability: 'read:Catalog',
  },
  getV1CatalogSkusByIdUsage: {
    method: 'GET',
    path: '/v1/catalog/skus/{id}/usage',
    ability: 'update:Catalog',
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
  getV1HrBranchOptions: {
    method: 'GET',
    path: '/v1/hr/branch-options',
    ability: 'create:Employee',
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
  getV1HrLoginOptions: { method: 'GET', path: '/v1/hr/login-options', ability: 'update:Payroll' },
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
  getV1InboxCallsById: {
    method: 'GET',
    path: '/v1/inbox/calls/{id}',
    ability: 'read:Conversation',
  },
  getV1InboxCallsLive: {
    method: 'GET',
    path: '/v1/inbox/calls/live',
    ability: 'read:Conversation',
  },
  getV1InboxMediaByFileId: {
    method: 'GET',
    path: '/v1/inbox/media/{fileId}',
    ability: 'read:Conversation',
  },
  getV1InboxOffersMine: {
    method: 'GET',
    path: '/v1/inbox/offers/mine',
    ability: 'read:Conversation',
  },
  getV1InboxProducts: { method: 'GET', path: '/v1/inbox/products', ability: 'read:Conversation' },
  getV1InboxSellingContext: {
    method: 'GET',
    path: '/v1/inbox/selling-context',
    ability: 'read:Conversation',
  },
  getV1InboxSizeChartsById: {
    method: 'GET',
    path: '/v1/inbox/size-charts/{id}',
    ability: 'read:Conversation',
  },
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
  getV1InventoryLocationsByIdUsage: {
    method: 'GET',
    path: '/v1/inventory/locations/{id}/usage',
    ability: 'update:Catalog',
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
  getV1InventoryStockInHand: {
    method: 'GET',
    path: '/v1/inventory/stock-in-hand',
    ability: 'create:Supply',
  },
  getV1InventoryStockInHandById: {
    method: 'GET',
    path: '/v1/inventory/stock-in-hand/{id}',
    ability: 'create:Supply',
  },
  getV1InventoryStockInHandWindow: {
    method: 'GET',
    path: '/v1/inventory/stock-in-hand/window',
    ability: 'read:Stock',
  },
  getV1InventoryStockProducts: {
    method: 'GET',
    path: '/v1/inventory/stock/products',
    ability: 'read:Stock',
  },
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
  getV1InvestorsLoginOptions: {
    method: 'GET',
    path: '/v1/investors/login-options',
    ability: 'update:Investor',
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
  getV1LabelsJobs: { method: 'GET', path: '/v1/labels/jobs', ability: 'update:Order' },
  getV1LabelsJobsExport: { method: 'GET', path: '/v1/labels/jobs/export', ability: 'update:Order' },
  getV1LabelsOrdersByOrderId: {
    method: 'GET',
    path: '/v1/labels/orders/{orderId}',
    ability: 'read:Order',
  },
  getV1LabelsPrinters: {
    method: 'GET',
    path: '/v1/labels/printers',
    ability: 'read:PackingTerminal',
  },
  getV1LabelsReady: { method: 'GET', path: '/v1/labels/ready', ability: 'update:Order' },
  getV1LabelsSettings: {
    method: 'GET',
    path: '/v1/labels/settings',
    ability: 'read:PackingTerminal',
  },
  getV1LabelsStationJobs: {
    method: 'GET',
    path: '/v1/labels/station/jobs',
    ability: 'update:Order',
  },
  getV1LabelsStationJobsByIdDocument: {
    method: 'GET',
    path: '/v1/labels/station/jobs/{id}/document',
    ability: 'update:Order',
  },
  getV1Loans: { method: 'GET', path: '/v1/loans', ability: 'read:CompanyLoan' },
  getV1LoansById: { method: 'GET', path: '/v1/loans/{id}', ability: 'read:CompanyLoan' },
  getV1LoansLenders: { method: 'GET', path: '/v1/loans/lenders', ability: 'read:CompanyLoan' },
  getV1MarketingCampaigns: {
    method: 'GET',
    path: '/v1/marketing/campaigns',
    ability: 'read:Campaign',
  },
  getV1MarketingCampaignsByIdUsage: {
    method: 'GET',
    path: '/v1/marketing/campaigns/{id}/usage',
    ability: 'update:Campaign',
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
  getV1MarketplaceNcom: { method: 'GET', path: '/v1/marketplace/ncom', ability: 'read:Storefront' },
  getV1MarketplaceNcomHolds: {
    method: 'GET',
    path: '/v1/marketplace/ncom/holds',
    ability: 'read:Storefront',
  },
  getV1MarketplaceNcomOrders: {
    method: 'GET',
    path: '/v1/marketplace/ncom/orders',
    ability: 'read:Storefront',
  },
  getV1NotifyMessages: { method: 'GET', path: '/v1/notify/messages', ability: 'read:Campaign' },
  getV1NotifyOptOuts: { method: 'GET', path: '/v1/notify/opt-outs', ability: 'read:Campaign' },
  getV1NotifyTemplates: { method: 'GET', path: '/v1/notify/templates', ability: 'read:Campaign' },
  getV1NotifyTemplatesByIdUsage: {
    method: 'GET',
    path: '/v1/notify/templates/{id}/usage',
    ability: 'update:Campaign',
  },
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
  getV1PackingHandover: { method: 'GET', path: '/v1/packing/handover', ability: 'update:Order' },
  getV1PackingOrdersByOrderId: {
    method: 'GET',
    path: '/v1/packing/orders/{orderId}',
    ability: 'read:Order',
  },
  getV1PackingSessions: { method: 'GET', path: '/v1/packing/sessions', ability: 'read:Order' },
  getV1PackingSessionsById: {
    method: 'GET',
    path: '/v1/packing/sessions/{id}',
    ability: 'read:Order',
  },
  getV1PackingSettings: { method: 'GET', path: '/v1/packing/settings', ability: 'update:Order' },
  getV1PackingVideosByIdUrl: {
    method: 'GET',
    path: '/v1/packing/videos/{id}/url',
    ability: 'read:PackingVideo',
  },
  getV1PosBranches: { method: 'GET', path: '/v1/pos/branches', ability: 'read:LedgerReport' },
  getV1PosBranchesByIdClosings: {
    method: 'GET',
    path: '/v1/pos/branches/{id}/closings',
    ability: 'read:Wallet',
  },
  getV1PosBranchesByIdHolds: {
    method: 'GET',
    path: '/v1/pos/branches/{id}/holds',
    ability: 'read:Branch',
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
  getV1PromoCodesByIdUsage: {
    method: 'GET',
    path: '/v1/promo/codes/{id}/usage',
    ability: 'update:LandingPage',
  },
  getV1PromoFlashSales: {
    method: 'GET',
    path: '/v1/promo/flash-sales',
    ability: 'read:LandingPage',
  },
  getV1PromoFlashSalesById: {
    method: 'GET',
    path: '/v1/promo/flash-sales/{id}',
    ability: 'read:LandingPage',
  },
  getV1PromoFlashSalesByIdUsage: {
    method: 'GET',
    path: '/v1/promo/flash-sales/{id}/usage',
    ability: 'update:LandingPage',
  },
  getV1ScannerDevices: { method: 'GET', path: '/v1/scanner/devices', ability: 'read:Order' },
  getV1ScannerLookup: { method: 'GET', path: '/v1/scanner/lookup', ability: 'read:Order' },
  getV1ScannerShipment: { method: 'GET', path: '/v1/scanner/shipment', ability: 'public' },
  getV1StorefrontAccounts: {
    method: 'GET',
    path: '/v1/storefront/accounts',
    ability: 'read:Customer',
  },
  getV1StorefrontCampaignLinks: {
    method: 'GET',
    path: '/v1/storefront/campaign-links',
    ability: 'read:Storefront',
  },
  getV1StorefrontCampaignLinksById: {
    method: 'GET',
    path: '/v1/storefront/campaign-links/{id}',
    ability: 'read:Storefront',
  },
  getV1StorefrontEmail: { method: 'GET', path: '/v1/storefront/email', ability: 'read:Storefront' },
  getV1StorefrontEmailLog: {
    method: 'GET',
    path: '/v1/storefront/email/log',
    ability: 'read:Customer',
  },
  getV1StorefrontHeroSlides: {
    method: 'GET',
    path: '/v1/storefront/hero-slides',
    ability: 'read:Storefront',
  },
  getV1StorefrontNavItems: {
    method: 'GET',
    path: '/v1/storefront/nav-items',
    ability: 'read:Storefront',
  },
  getV1StorefrontNavItemsByIdUsage: {
    method: 'GET',
    path: '/v1/storefront/nav-items/{id}/usage',
    ability: 'update:Storefront',
  },
  getV1StorefrontOrdersByOrderId: {
    method: 'GET',
    path: '/v1/storefront/orders/{orderId}',
    ability: 'read:Order',
  },
  getV1StorefrontPayments: {
    method: 'GET',
    path: '/v1/storefront/payments',
    ability: 'read:Storefront',
  },
  getV1StorefrontPaymentsSessions: {
    method: 'GET',
    path: '/v1/storefront/payments/sessions',
    ability: 'read:Customer',
  },
  getV1StorefrontSettings: {
    method: 'GET',
    path: '/v1/storefront/settings',
    ability: 'read:Storefront',
  },
  getV1StorefrontSiteKeys: {
    method: 'GET',
    path: '/v1/storefront/site-keys',
    ability: 'read:Storefront',
  },
  getV1StorefrontSizeCharts: {
    method: 'GET',
    path: '/v1/storefront/size-charts',
    ability: 'read:Storefront',
  },
  getV1StorefrontSizeChartsByIdUsage: {
    method: 'GET',
    path: '/v1/storefront/size-charts/{id}/usage',
    ability: 'update:Storefront',
  },
  getV1StorefrontTracking: {
    method: 'GET',
    path: '/v1/storefront/tracking',
    ability: 'read:Storefront',
  },
  getV1StorefrontTrackingEvents: {
    method: 'GET',
    path: '/v1/storefront/tracking/events',
    ability: 'read:Storefront',
  },
  getV1SupplyEntries: { method: 'GET', path: '/v1/supply/entries', ability: 'read:Supply' },
  getV1SupplyEntriesById: {
    method: 'GET',
    path: '/v1/supply/entries/{id}',
    ability: 'read:Supply',
  },
  getV1SupplyPayments: { method: 'GET', path: '/v1/supply/payments', ability: 'read:Supply' },
  getV1SupplyReturns: { method: 'GET', path: '/v1/supply/returns', ability: 'read:Supply' },
  getV1SupplySkuCosts: { method: 'GET', path: '/v1/supply/sku-costs', ability: 'read:Cost' },
  getV1SupplySkuCostsExport: {
    method: 'GET',
    path: '/v1/supply/sku-costs/export',
    ability: 'read:Cost',
  },
  getV1SupplySupplierOptions: {
    method: 'GET',
    path: '/v1/supply/supplier-options',
    ability: 'create:Supply',
  },
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
  getV1SupplySuppliersByIdUsage: {
    method: 'GET',
    path: '/v1/supply/suppliers/{id}/usage',
    ability: 'update:Supply',
  },
  getV1TelephonyAssignments: {
    method: 'GET',
    path: '/v1/telephony/assignments',
    ability: 'read:PhoneExtension',
  },
  getV1TelephonyCalls: { method: 'GET', path: '/v1/telephony/calls', ability: 'read:PhoneCall' },
  getV1TelephonyCallsById: {
    method: 'GET',
    path: '/v1/telephony/calls/{id}',
    ability: 'read:PhoneCall',
  },
  getV1TelephonyCallsByIdRecording: {
    method: 'GET',
    path: '/v1/telephony/calls/{id}/recording',
    ability: 'read:PhoneCall',
  },
  getV1TelephonyCallsWrapUps: {
    method: 'GET',
    path: '/v1/telephony/calls/wrap-ups',
    ability: 'create:PhoneCall',
  },
  getV1TelephonyConnectionsByIdExtensions: {
    method: 'GET',
    path: '/v1/telephony/connections/{id}/extensions',
    ability: 'read:PhoneExtension',
  },
  getV1TelephonyConnectionsByIdLive: {
    method: 'GET',
    path: '/v1/telephony/connections/{id}/live',
    ability: 'read:Telephony',
  },
  getV1TelephonyMe: { method: 'GET', path: '/v1/telephony/me', ability: 'read:PhoneCall' },
  getV1TelephonyPhoneToken: {
    method: 'GET',
    path: '/v1/telephony/phone/token',
    ability: 'create:PhoneCall',
  },
  getV1Terminals: { method: 'GET', path: '/v1/terminals', ability: 'read:PackingTerminal' },
  getWebhooksMetaByOrgId: { method: 'GET', path: '/webhooks/meta/{orgId}', ability: 'public' },
  getWorkflowSettings: {
    method: 'GET',
    path: '/v1/orders/workflow-settings',
    ability: 'read:OrderWorkflow',
  },
  handOverInboxConversation: {
    method: 'POST',
    path: '/v1/inbox/conversations/{id}/hand-over',
    ability: 'update:Conversation',
  },
  healthLive: { method: 'GET', path: '/health/live', ability: 'public' },
  healthReady: { method: 'GET', path: '/health/ready', ability: 'public' },
  inboxUnreadCounts: { method: 'GET', path: '/v1/inbox/unread', ability: 'read:Conversation' },
  listApprovals: { method: 'GET', path: '/v1/approvals', ability: 'read:ApprovalRequest' },
  listDemoCostedItems: { method: 'GET', path: '/v1/demo/costed-items', ability: 'read:CostedItem' },
  listDeskProfiles: { method: 'GET', path: '/v1/team/profiles', ability: 'read:User' },
  listInboxChannels: { method: 'GET', path: '/v1/inbox/channels', ability: 'read:InboxChannel' },
  listInboxConversations: {
    method: 'GET',
    path: '/v1/inbox/conversations',
    ability: 'read:Conversation',
  },
  listInboxTeam: { method: 'GET', path: '/v1/inbox/team', ability: 'read:Conversation' },
  listLedgerAccounts: { method: 'GET', path: '/v1/ledger/accounts', ability: 'read:LedgerReport' },
  listMyOrgs: { method: 'GET', path: '/v1/me/orgs', ability: 'authenticated' },
  listMySessions: { method: 'GET', path: '/v1/account/sessions', ability: 'authenticated' },
  listOrderCalls: { method: 'GET', path: '/v1/orders/{id}/calls', ability: 'read:Order' },
  listPackingCameras: { method: 'GET', path: '/v1/packing/cameras', ability: 'update:Order' },
  listPeriods: { method: 'GET', path: '/v1/ledger/periods', ability: 'read:LedgerPeriod' },
  listSavedReplies: { method: 'GET', path: '/v1/inbox/saved-replies', ability: 'read:SavedReply' },
  listTelephonyConnections: {
    method: 'GET',
    path: '/v1/telephony/connections',
    ability: 'read:Telephony',
  },
  listUsers: { method: 'GET', path: '/v1/users', ability: 'read:User' },
  listWallets: { method: 'GET', path: '/v1/ledger/wallets', ability: 'read:Wallet' },
  loginBranding: { method: 'GET', path: '/v1/auth/login-branding', ability: 'public' },
  logOrderCall: { method: 'POST', path: '/v1/orders/{id}/calls', ability: 'update:Order' },
  lookupPhoneCaller: { method: 'POST', path: '/v1/telephony/lookup', ability: 'create:PhoneCall' },
  markSlipsPrinted: { method: 'POST', path: '/v1/orders/mark-printed', ability: 'update:Order' },
  me: { method: 'GET', path: '/v1/me', ability: 'authenticated' },
  myOrderOffers: { method: 'GET', path: '/v1/orders/offers/mine', ability: 'read:Order' },
  newMyRecoveryCodes: {
    method: 'POST',
    path: '/v1/account/two-factor/recovery-codes',
    ability: 'authenticated',
  },
  packingCameraPreview: {
    method: 'GET',
    path: '/v1/packing/cameras/{id}/preview',
    ability: 'update:Order',
  },
  partyBalances: { method: 'GET', path: '/v1/ledger/party-balances', ability: 'read:LedgerReport' },
  patchStorefrontV1AccountsById: {
    method: 'PATCH',
    path: '/storefront/v1/accounts/{id}',
    ability: 'public',
  },
  patchV1AccountsHeadsById: {
    method: 'PATCH',
    path: '/v1/accounts/heads/{id}',
    ability: 'update:Wallet',
  },
  patchV1AccountsWalletsById: {
    method: 'PATCH',
    path: '/v1/accounts/wallets/{id}',
    ability: 'update:Wallet',
  },
  patchV1CatalogAttributesById: {
    method: 'PATCH',
    path: '/v1/catalog/attributes/{id}',
    ability: 'update:Catalog',
  },
  patchV1CatalogAttributesByIdValuesByValueId: {
    method: 'PATCH',
    path: '/v1/catalog/attributes/{id}/values/{valueId}',
    ability: 'update:Catalog',
  },
  patchV1CatalogCategoriesById: {
    method: 'PATCH',
    path: '/v1/catalog/categories/{id}',
    ability: 'update:Catalog',
  },
  patchV1CatalogProducts: {
    method: 'PATCH',
    path: '/v1/catalog/products',
    ability: 'update:Catalog',
  },
  patchV1CatalogProductsById: {
    method: 'PATCH',
    path: '/v1/catalog/products/{id}',
    ability: 'update:Catalog',
  },
  patchV1CatalogSkus: { method: 'PATCH', path: '/v1/catalog/skus', ability: 'update:Catalog' },
  patchV1CatalogSkusById: {
    method: 'PATCH',
    path: '/v1/catalog/skus/{id}',
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
  patchV1InventoryStockInHandDraftsById: {
    method: 'PATCH',
    path: '/v1/inventory/stock-in-hand/drafts/{id}',
    ability: 'update:Supply',
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
  patchV1PosBranchesById: {
    method: 'PATCH',
    path: '/v1/pos/branches/{id}',
    ability: 'update:Branch',
  },
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
  patchV1PromoFlashSalesById: {
    method: 'PATCH',
    path: '/v1/promo/flash-sales/{id}',
    ability: 'update:LandingPage',
  },
  patchV1StorefrontSettings: {
    method: 'PATCH',
    path: '/v1/storefront/settings',
    ability: 'update:Storefront',
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
  phoneCallerPanel: {
    method: 'POST',
    path: '/v1/telephony/caller-panel',
    ability: 'read:PhoneCall',
  },
  pinCustomerNote: {
    method: 'PUT',
    path: '/v1/customers/{id}/pinned-note',
    ability: 'read:PhoneCall',
  },
  placePhoneCall: { method: 'POST', path: '/v1/telephony/calls', ability: 'create:PhoneCall' },
  postApiAdminScannerLogin: { method: 'POST', path: '/api/admin/scanner/login', ability: 'public' },
  postNcomByOrgIdOrders: { method: 'POST', path: '/ncom/{orgId}/orders', ability: 'public' },
  postNcomByOrgIdV1Release: { method: 'POST', path: '/ncom/{orgId}/v1/release', ability: 'public' },
  postNcomByOrgIdV1Reserve: { method: 'POST', path: '/ncom/{orgId}/v1/reserve', ability: 'public' },
  postNcomByOrgIdV1Stock: { method: 'POST', path: '/ncom/{orgId}/v1/stock', ability: 'public' },
  postNcomByOrgIdWebhook: { method: 'POST', path: '/ncom/{orgId}/webhook', ability: 'public' },
  postPublicV1Orders: { method: 'POST', path: '/public/v1/orders', ability: 'public' },
  postStorefrontIpnSslcommerzByOrgId: {
    method: 'POST',
    path: '/storefront/ipn/sslcommerz/{orgId}',
    ability: 'public',
  },
  postStorefrontV1AccountsByIdChangePassword: {
    method: 'POST',
    path: '/storefront/v1/accounts/{id}/change-password',
    ability: 'public',
  },
  postStorefrontV1AccountsForgotPassword: {
    method: 'POST',
    path: '/storefront/v1/accounts/forgot-password',
    ability: 'public',
  },
  postStorefrontV1AccountsGoogle: {
    method: 'POST',
    path: '/storefront/v1/accounts/google',
    ability: 'public',
  },
  postStorefrontV1AccountsRegister: {
    method: 'POST',
    path: '/storefront/v1/accounts/register',
    ability: 'public',
  },
  postStorefrontV1AccountsResendCode: {
    method: 'POST',
    path: '/storefront/v1/accounts/resend-code',
    ability: 'public',
  },
  postStorefrontV1AccountsResetPassword: {
    method: 'POST',
    path: '/storefront/v1/accounts/reset-password',
    ability: 'public',
  },
  postStorefrontV1AccountsSignIn: {
    method: 'POST',
    path: '/storefront/v1/accounts/sign-in',
    ability: 'public',
  },
  postStorefrontV1AccountsVerifyEmail: {
    method: 'POST',
    path: '/storefront/v1/accounts/verify-email',
    ability: 'public',
  },
  postStorefrontV1CartQuote: {
    method: 'POST',
    path: '/storefront/v1/cart/quote',
    ability: 'public',
  },
  postStorefrontV1Checkout: { method: 'POST', path: '/storefront/v1/checkout', ability: 'public' },
  postStorefrontV1CustomLinksByCodeViews: {
    method: 'POST',
    path: '/storefront/v1/custom-links/{code}/views',
    ability: 'public',
  },
  postStorefrontV1Events: { method: 'POST', path: '/storefront/v1/events', ability: 'public' },
  postStorefrontV1PaymentsSslcommerzInit: {
    method: 'POST',
    path: '/storefront/v1/payments/sslcommerz/init',
    ability: 'public',
  },
  postStorefrontV1PaymentsSslcommerzReturn: {
    method: 'POST',
    path: '/storefront/v1/payments/sslcommerz/return',
    ability: 'public',
  },
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
  postV1AccountsHeads: { method: 'POST', path: '/v1/accounts/heads', ability: 'update:Wallet' },
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
  postV1AuthOwnerLink: { method: 'POST', path: '/v1/auth/owner-link', ability: 'public' },
  postV1CatalogAttributes: {
    method: 'POST',
    path: '/v1/catalog/attributes',
    ability: 'create:Catalog',
  },
  postV1CatalogAttributesByIdArchive: {
    method: 'POST',
    path: '/v1/catalog/attributes/{id}/archive',
    ability: 'update:Catalog',
  },
  postV1CatalogAttributesByIdRestore: {
    method: 'POST',
    path: '/v1/catalog/attributes/{id}/restore',
    ability: 'update:Catalog',
  },
  postV1CatalogAttributesByIdValues: {
    method: 'POST',
    path: '/v1/catalog/attributes/{id}/values',
    ability: 'create:Catalog',
  },
  postV1CatalogAttributesByIdValuesByValueIdArchive: {
    method: 'POST',
    path: '/v1/catalog/attributes/{id}/values/{valueId}/archive',
    ability: 'update:Catalog',
  },
  postV1CatalogAttributesByIdValuesByValueIdRestore: {
    method: 'POST',
    path: '/v1/catalog/attributes/{id}/values/{valueId}/restore',
    ability: 'update:Catalog',
  },
  postV1CatalogCategories: {
    method: 'POST',
    path: '/v1/catalog/categories',
    ability: 'create:Catalog',
  },
  postV1CatalogCategoriesByIdArchive: {
    method: 'POST',
    path: '/v1/catalog/categories/{id}/archive',
    ability: 'update:Catalog',
  },
  postV1CatalogCategoriesByIdEmptyAndDelete: {
    method: 'POST',
    path: '/v1/catalog/categories/{id}/empty-and-delete',
    ability: 'delete:Catalog',
  },
  postV1CatalogCategoriesByIdRestore: {
    method: 'POST',
    path: '/v1/catalog/categories/{id}/restore',
    ability: 'update:Catalog',
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
  postV1CatalogImportsProducts: {
    method: 'POST',
    path: '/v1/catalog/imports/products',
    ability: 'create:Catalog',
  },
  postV1CatalogImportsProductsDryRun: {
    method: 'POST',
    path: '/v1/catalog/imports/products/dry-run',
    ability: 'read:Catalog',
  },
  postV1CatalogLabels: { method: 'POST', path: '/v1/catalog/labels', ability: 'read:Catalog' },
  postV1CatalogProducts: {
    method: 'POST',
    path: '/v1/catalog/products',
    ability: 'create:Catalog',
  },
  postV1CatalogProductsByIdDuplicate: {
    method: 'POST',
    path: '/v1/catalog/products/{id}/duplicate',
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
  postV1CatalogProductsDuplicate: {
    method: 'POST',
    path: '/v1/catalog/products/duplicate',
    ability: 'create:Catalog',
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
  postV1InboxCallsByIdAnswer: {
    method: 'POST',
    path: '/v1/inbox/calls/{id}/answer',
    ability: 'update:Conversation',
  },
  postV1InboxCallsByIdCallbackDone: {
    method: 'POST',
    path: '/v1/inbox/calls/{id}/callback-done',
    ability: 'update:Conversation',
  },
  postV1InboxCallsByIdClaim: {
    method: 'POST',
    path: '/v1/inbox/calls/{id}/claim',
    ability: 'update:Conversation',
  },
  postV1InboxCallsByIdDecline: {
    method: 'POST',
    path: '/v1/inbox/calls/{id}/decline',
    ability: 'update:Conversation',
  },
  postV1InboxCallsByIdHangUp: {
    method: 'POST',
    path: '/v1/inbox/calls/{id}/hang-up',
    ability: 'update:Conversation',
  },
  postV1InboxCallsByIdRelease: {
    method: 'POST',
    path: '/v1/inbox/calls/{id}/release',
    ability: 'update:Conversation',
  },
  postV1InboxConversationsByIdVoice: {
    method: 'POST',
    path: '/v1/inbox/conversations/{id}/voice',
    ability: 'update:Conversation',
  },
  postV1InboxOffersByIdAccept: {
    method: 'POST',
    path: '/v1/inbox/offers/{id}/accept',
    ability: 'update:Conversation',
  },
  postV1InboxOffersByIdDecline: {
    method: 'POST',
    path: '/v1/inbox/offers/{id}/decline',
    ability: 'update:Conversation',
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
  postV1InventoryCountsByIdScans: {
    method: 'POST',
    path: '/v1/inventory/counts/{id}/scans',
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
  postV1InventoryLocationsByIdArchive: {
    method: 'POST',
    path: '/v1/inventory/locations/{id}/archive',
    ability: 'update:Catalog',
  },
  postV1InventoryLocationsByIdRestore: {
    method: 'POST',
    path: '/v1/inventory/locations/{id}/restore',
    ability: 'update:Catalog',
  },
  postV1InventoryStockInHand: {
    method: 'POST',
    path: '/v1/inventory/stock-in-hand',
    ability: 'read:Cost',
  },
  postV1InventoryStockInHandByIdPost: {
    method: 'POST',
    path: '/v1/inventory/stock-in-hand/{id}/post',
    ability: 'read:Cost',
  },
  postV1InventoryStockInHandByIdReverse: {
    method: 'POST',
    path: '/v1/inventory/stock-in-hand/{id}/reverse',
    ability: 'read:Cost',
  },
  postV1InventoryStockInHandDrafts: {
    method: 'POST',
    path: '/v1/inventory/stock-in-hand/drafts',
    ability: 'create:Supply',
  },
  postV1InventoryStockInHandWindowClose: {
    method: 'POST',
    path: '/v1/inventory/stock-in-hand/window/close',
    ability: 'approve:StockAdjustment',
  },
  postV1InventoryStockInHandWindowReopen: {
    method: 'POST',
    path: '/v1/inventory/stock-in-hand/window/reopen',
    ability: 'approve:StockAdjustment',
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
  postV1LabelsJobsByIdCancel: {
    method: 'POST',
    path: '/v1/labels/jobs/{id}/cancel',
    ability: 'update:Order',
  },
  postV1LabelsJobsByIdRetry: {
    method: 'POST',
    path: '/v1/labels/jobs/{id}/retry',
    ability: 'update:Order',
  },
  postV1LabelsPrint: { method: 'POST', path: '/v1/labels/print', ability: 'update:Order' },
  postV1LabelsPrinters: {
    method: 'POST',
    path: '/v1/labels/printers',
    ability: 'create:PackingTerminal',
  },
  postV1LabelsPrintersByIdTest: {
    method: 'POST',
    path: '/v1/labels/printers/{id}/test',
    ability: 'update:PackingTerminal',
  },
  postV1LabelsStationJobsByIdResult: {
    method: 'POST',
    path: '/v1/labels/station/jobs/{id}/result',
    ability: 'update:Order',
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
  postV1MarketplaceNcomHoldsByIdRelease: {
    method: 'POST',
    path: '/v1/marketplace/ncom/holds/{id}/release',
    ability: 'update:WebsiteCredentials',
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
  postV1PackingHandover: { method: 'POST', path: '/v1/packing/handover', ability: 'update:Order' },
  postV1PackingHandoverScans: {
    method: 'POST',
    path: '/v1/packing/handover/scans',
    ability: 'update:Order',
  },
  postV1PackingLabels: { method: 'POST', path: '/v1/packing/labels', ability: 'read:Order' },
  postV1PackingSessions: { method: 'POST', path: '/v1/packing/sessions', ability: 'update:Order' },
  postV1PackingSessionsByIdComplete: {
    method: 'POST',
    path: '/v1/packing/sessions/{id}/complete',
    ability: 'update:Order',
  },
  postV1PackingSessionsByIdLotsClose: {
    method: 'POST',
    path: '/v1/packing/sessions/{id}/lots/close',
    ability: 'update:Order',
  },
  postV1PackingSessionsByIdRemovals: {
    method: 'POST',
    path: '/v1/packing/sessions/{id}/removals',
    ability: 'update:Order',
  },
  postV1PackingSessionsByIdScans: {
    method: 'POST',
    path: '/v1/packing/sessions/{id}/scans',
    ability: 'update:Order',
  },
  postV1PackingSessionsByIdVideos: {
    method: 'POST',
    path: '/v1/packing/sessions/{id}/videos',
    ability: 'update:Order',
  },
  postV1PackingSessionsByIdVideosByVideoIdFile: {
    method: 'POST',
    path: '/v1/packing/sessions/{id}/videos/{videoId}/file',
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
  postV1PromoCodesByIdRestore: {
    method: 'POST',
    path: '/v1/promo/codes/{id}/restore',
    ability: 'update:LandingPage',
  },
  postV1PromoFlashSales: {
    method: 'POST',
    path: '/v1/promo/flash-sales',
    ability: 'create:LandingPage',
  },
  postV1PromoFlashSalesByIdArchive: {
    method: 'POST',
    path: '/v1/promo/flash-sales/{id}/archive',
    ability: 'update:LandingPage',
  },
  postV1PromoFlashSalesByIdDuplicate: {
    method: 'POST',
    path: '/v1/promo/flash-sales/{id}/duplicate',
    ability: 'create:LandingPage',
  },
  postV1PromoFlashSalesByIdRestore: {
    method: 'POST',
    path: '/v1/promo/flash-sales/{id}/restore',
    ability: 'update:LandingPage',
  },
  postV1ScannerDevices: { method: 'POST', path: '/v1/scanner/devices', ability: 'read:Order' },
  postV1ScannerDevicesByIdRevoke: {
    method: 'POST',
    path: '/v1/scanner/devices/{id}/revoke',
    ability: 'read:Order',
  },
  postV1ScannerSignIn: { method: 'POST', path: '/v1/scanner/sign-in', ability: 'public' },
  postV1ScannerSignOut: { method: 'POST', path: '/v1/scanner/sign-out', ability: 'public' },
  postV1StorefrontCampaignLinks: {
    method: 'POST',
    path: '/v1/storefront/campaign-links',
    ability: 'create:Storefront',
  },
  postV1StorefrontEmailTest: {
    method: 'POST',
    path: '/v1/storefront/email/test',
    ability: 'update:WebsiteCredentials',
  },
  postV1StorefrontHeroSlides: {
    method: 'POST',
    path: '/v1/storefront/hero-slides',
    ability: 'create:Storefront',
  },
  postV1StorefrontNavItems: {
    method: 'POST',
    path: '/v1/storefront/nav-items',
    ability: 'create:Storefront',
  },
  postV1StorefrontSiteKeys: {
    method: 'POST',
    path: '/v1/storefront/site-keys',
    ability: 'create:Storefront',
  },
  postV1StorefrontSiteKeysByIdRevoke: {
    method: 'POST',
    path: '/v1/storefront/site-keys/{id}/revoke',
    ability: 'update:Storefront',
  },
  postV1StorefrontSizeCharts: {
    method: 'POST',
    path: '/v1/storefront/size-charts',
    ability: 'create:Storefront',
  },
  postV1StorefrontSizeChartsByIdEmptyAndDelete: {
    method: 'POST',
    path: '/v1/storefront/size-charts/{id}/empty-and-delete',
    ability: 'delete:Storefront',
  },
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
  postV1SupplySkuCostsImport: {
    method: 'POST',
    path: '/v1/supply/sku-costs/import',
    ability: 'read:Cost',
  },
  postV1SupplySkuCostsImportDryRun: {
    method: 'POST',
    path: '/v1/supply/sku-costs/import/dry-run',
    ability: 'read:Cost',
  },
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
  postV1TelephonyConnectionsByIdLiveByCallIdHangup: {
    method: 'POST',
    path: '/v1/telephony/connections/{id}/live/{callId}/hangup',
    ability: 'update:PhoneCall',
  },
  postV1Terminals: { method: 'POST', path: '/v1/terminals', ability: 'create:PackingTerminal' },
  postV1TerminalsByIdBind: {
    method: 'POST',
    path: '/v1/terminals/{id}/bind',
    ability: 'update:PackingTerminal',
  },
  postV1TerminalsCheckIn: {
    method: 'POST',
    path: '/v1/terminals/check-in',
    ability: 'read:PackingTerminal',
  },
  postV1TerminalsDevicesByIdRevoke: {
    method: 'POST',
    path: '/v1/terminals/devices/{id}/revoke',
    ability: 'update:PackingTerminal',
  },
  postV1Track: { method: 'POST', path: '/v1/track', ability: 'public' },
  postWebhooksEnvoByOrgIdByConnectionId: {
    method: 'POST',
    path: '/webhooks/envo/{orgId}/{connectionId}',
    ability: 'public',
  },
  postWebhooksMetaByOrgId: { method: 'POST', path: '/webhooks/meta/{orgId}', ability: 'public' },
  putV1CatalogAttributesByIdValuesOrder: {
    method: 'PUT',
    path: '/v1/catalog/attributes/{id}/values/order',
    ability: 'update:Catalog',
  },
  putV1CatalogPrices: { method: 'PUT', path: '/v1/catalog/prices', ability: 'update:Catalog' },
  putV1CatalogProductsByIdImagesByImageIdColour: {
    method: 'PUT',
    path: '/v1/catalog/products/{id}/images/{imageId}/colour',
    ability: 'update:Catalog',
  },
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
  putV1CatalogSkusByIdWeight: {
    method: 'PUT',
    path: '/v1/catalog/skus/{id}/weight',
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
  putV1LabelsPrintersById: {
    method: 'PUT',
    path: '/v1/labels/printers/{id}',
    ability: 'update:PackingTerminal',
  },
  putV1LabelsSettings: {
    method: 'PUT',
    path: '/v1/labels/settings',
    ability: 'update:PackingTerminal',
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
  putV1MarketplaceNcom: {
    method: 'PUT',
    path: '/v1/marketplace/ncom',
    ability: 'update:WebsiteCredentials',
  },
  putV1NotifyTemplates: { method: 'PUT', path: '/v1/notify/templates', ability: 'update:Campaign' },
  putV1PackingOrdersByOrderIdLots: {
    method: 'PUT',
    path: '/v1/packing/orders/{orderId}/lots',
    ability: 'update:Order',
  },
  putV1PackingSettings: {
    method: 'PUT',
    path: '/v1/packing/settings',
    ability: 'update:PackingVideo',
  },
  putV1PromoFlashSalesById: {
    method: 'PUT',
    path: '/v1/promo/flash-sales/{id}',
    ability: 'update:LandingPage',
  },
  putV1StorefrontCampaignLinksById: {
    method: 'PUT',
    path: '/v1/storefront/campaign-links/{id}',
    ability: 'update:Storefront',
  },
  putV1StorefrontCategoriesById: {
    method: 'PUT',
    path: '/v1/storefront/categories/{id}',
    ability: 'update:Storefront',
  },
  putV1StorefrontEmail: {
    method: 'PUT',
    path: '/v1/storefront/email',
    ability: 'update:WebsiteCredentials',
  },
  putV1StorefrontHeroSlidesById: {
    method: 'PUT',
    path: '/v1/storefront/hero-slides/{id}',
    ability: 'update:Storefront',
  },
  putV1StorefrontHeroSlidesOrder: {
    method: 'PUT',
    path: '/v1/storefront/hero-slides/order',
    ability: 'update:Storefront',
  },
  putV1StorefrontNavItemsById: {
    method: 'PUT',
    path: '/v1/storefront/nav-items/{id}',
    ability: 'update:Storefront',
  },
  putV1StorefrontNavItemsLayout: {
    method: 'PUT',
    path: '/v1/storefront/nav-items/layout',
    ability: 'update:Storefront',
  },
  putV1StorefrontPayments: {
    method: 'PUT',
    path: '/v1/storefront/payments',
    ability: 'update:WebsiteCredentials',
  },
  putV1StorefrontProducts: {
    method: 'PUT',
    path: '/v1/storefront/products',
    ability: 'update:Storefront',
  },
  putV1StorefrontProductsById: {
    method: 'PUT',
    path: '/v1/storefront/products/{id}',
    ability: 'update:Storefront',
  },
  putV1StorefrontSizeChartsById: {
    method: 'PUT',
    path: '/v1/storefront/size-charts/{id}',
    ability: 'update:Storefront',
  },
  putV1StorefrontTracking: {
    method: 'PUT',
    path: '/v1/storefront/tracking',
    ability: 'update:Storefront',
  },
  putV1SupplySkuCosts: { method: 'PUT', path: '/v1/supply/sku-costs', ability: 'read:Cost' },
  putV1TerminalsById: {
    method: 'PUT',
    path: '/v1/terminals/{id}',
    ability: 'update:PackingTerminal',
  },
  putV1TerminalsByIdCameras: {
    method: 'PUT',
    path: '/v1/terminals/{id}/cameras',
    ability: 'update:PackingTerminal',
  },
  putV1TerminalsByIdMembers: {
    method: 'PUT',
    path: '/v1/terminals/{id}/members',
    ability: 'update:PackingTerminal',
  },
  readInboxConversation: {
    method: 'POST',
    path: '/v1/inbox/conversations/{id}/read',
    ability: 'update:Conversation',
  },
  releaseInboxConversation: {
    method: 'POST',
    path: '/v1/inbox/conversations/{id}/release',
    ability: 'update:Conversation',
  },
  releaseOrder: { method: 'POST', path: '/v1/orders/{id}/release', ability: 'update:Order' },
  removeInboxInterest: {
    method: 'DELETE',
    path: '/v1/inbox/conversations/{id}/interests/{interestId}',
    ability: 'update:Conversation',
  },
  reopenInboxConversation: {
    method: 'POST',
    path: '/v1/inbox/conversations/{id}/reopen',
    ability: 'update:Conversation',
  },
  reopenPeriod: {
    method: 'POST',
    path: '/v1/ledger/periods/reopen',
    ability: 'update:LedgerPeriod',
  },
  replyInInboxConversation: {
    method: 'POST',
    path: '/v1/inbox/conversations/{id}/messages',
    ability: 'update:Conversation',
  },
  reportPresence: { method: 'POST', path: '/v1/team/presence', ability: 'update:Presence' },
  resetUserTwoFactor: {
    method: 'POST',
    path: '/v1/users/{id}/two-factor/reset',
    ability: 'update:User',
  },
  saveDeskProfile: { method: 'PUT', path: '/v1/team/profiles/{userId}', ability: 'update:User' },
  saveInboxChannel: {
    method: 'PUT',
    path: '/v1/inbox/channels/{kind}',
    ability: 'update:InboxChannel',
  },
  saveInboxContactAddress: {
    method: 'PUT',
    path: '/v1/inbox/conversations/{id}/contact/address',
    ability: 'update:Conversation',
  },
  saveInboxContactPhone: {
    method: 'PUT',
    path: '/v1/inbox/conversations/{id}/contact/phone',
    ability: 'update:Conversation',
  },
  saveInboxMetaApp: { method: 'PUT', path: '/v1/inbox/meta-app', ability: 'update:InboxChannel' },
  saveWorkflowSettings: {
    method: 'PUT',
    path: '/v1/orders/workflow-settings',
    ability: 'update:OrderWorkflow',
  },
  searchPhoneCalls: {
    method: 'POST',
    path: '/v1/telephony/calls/search',
    ability: 'read:PhoneCall',
  },
  setApprovalThresholds: {
    method: 'PUT',
    path: '/v1/approvals/thresholds',
    ability: 'update:ApprovalThreshold',
  },
  setInboxContactStage: {
    method: 'PUT',
    path: '/v1/inbox/conversations/{id}/contact/stage',
    ability: 'update:Conversation',
  },
  setInboxContactTags: {
    method: 'PUT',
    path: '/v1/inbox/conversations/{id}/contact/tags',
    ability: 'update:Conversation',
  },
  setNotTakingOrders: {
    method: 'POST',
    path: '/v1/team/presence/pause',
    ability: 'update:Presence',
  },
  setTwoFactorPolicy: {
    method: 'PUT',
    path: '/v1/security/two-factor-policy',
    ability: 'update:SecurityPolicy',
  },
  setUserRoles: { method: 'PUT', path: '/v1/users/{id}/roles', ability: 'update:User' },
  signOutUserEverywhere: {
    method: 'POST',
    path: '/v1/users/{id}/sign-out-everywhere',
    ability: 'update:User',
  },
  startTwoFactorReplacement: {
    method: 'POST',
    path: '/v1/account/two-factor/replace',
    ability: 'authenticated',
  },
  stepDownSuperAdmin: { method: 'POST', path: '/v1/users/me/step-down', ability: 'update:User' },
  switchOrg: { method: 'POST', path: '/v1/me/active-org', ability: 'authenticated' },
  takeInboxConversation: {
    method: 'POST',
    path: '/v1/inbox/conversations/{id}/take',
    ability: 'update:Conversation',
  },
  teamBoard: { method: 'GET', path: '/v1/orders/team-board', ability: 'read:OrderWorkflow' },
  testTelephonyConnection: {
    method: 'POST',
    path: '/v1/telephony/connections/{id}/test',
    ability: 'update:Telephony',
  },
  trialBalance: { method: 'GET', path: '/v1/ledger/trial-balance', ability: 'read:LedgerReport' },
  turnOffMyTwoFactor: {
    method: 'POST',
    path: '/v1/account/two-factor/turn-off',
    ability: 'authenticated',
  },
  turnOffUserTwoFactor: {
    method: 'POST',
    path: '/v1/users/{id}/two-factor/turn-off',
    ability: 'update:User',
  },
  updateMyProfile: { method: 'PATCH', path: '/v1/account/profile', ability: 'authenticated' },
  updatePackingCamera: {
    method: 'PUT',
    path: '/v1/packing/cameras/{id}',
    ability: 'update:PackingVideo',
  },
  updateSavedReply: {
    method: 'PUT',
    path: '/v1/inbox/saved-replies/{id}',
    ability: 'update:SavedReply',
  },
  updateTelephonyConnection: {
    method: 'PUT',
    path: '/v1/telephony/connections/{id}',
    ability: 'update:Telephony',
  },
  userPasswordLink: {
    method: 'POST',
    path: '/v1/users/{id}/password-link',
    ability: 'update:User',
  },
  voteSuperAdmin: { method: 'POST', path: '/v1/users/{id}/super-admin', ability: 'update:User' },
  voteSuperAdminRemoval: {
    method: 'POST',
    path: '/v1/users/{id}/super-admin-removal',
    ability: 'update:User',
  },
  voteUserTrust: { method: 'POST', path: '/v1/users/{id}/trust', ability: 'update:User' },
  withdrawSuperAdminNomination: {
    method: 'DELETE',
    path: '/v1/users/{id}/super-admin',
    ability: 'update:User',
  },
  withdrawSuperAdminRemoval: {
    method: 'DELETE',
    path: '/v1/users/{id}/super-admin-removal',
    ability: 'update:User',
  },
  withdrawUserTrust: { method: 'DELETE', path: '/v1/users/{id}/trust', ability: 'update:User' },
  wrapUpPhoneCall: {
    method: 'POST',
    path: '/v1/telephony/calls/{id}/wrap-up',
    ability: 'create:PhoneCall',
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
    /** Accept an offered order: it is yours if nobody took it first. */
    acceptOrderOffer: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.acceptOrderOffer, input, options),
    /** Every posting to one account over a date range. */
    accountLedger: (
      input: {
        readonly path: { readonly id: string };
        readonly query: { readonly from?: string; readonly to: string };
      },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.accountLedger, input, options),
    /** A product (and optionally a size) the contact asked about. */
    addInboxInterest: (
      input: { readonly path: { readonly id: string }; readonly body: InboxInterestInput },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.addInboxInterest, input, options),
    /** A dated note on the contact, signed by its author. */
    addInboxNote: (
      input: { readonly path: { readonly id: string }; readonly body: InboxNoteInput },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.addInboxNote, input, options),
    /** Add an IP camera over a packing table. Its password is sealed and never returned. */
    addPackingCamera: (
      input: { readonly body: PackingCameraCreateInput },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.addPackingCamera, input, options),
    /** The browser's phone answered an incoming call from this number. */
    answeredPhoneCall: (
      input: { readonly body: PhoneCallAnsweredInput },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.answeredPhoneCall, input, options),
    /** Give an extension to a person: one person per extension, one extension per person. */
    assignTelephonyExtension: (
      input: {
        readonly path: { readonly extension: string; readonly id: string };
        readonly body: TelephonyAssignInput;
      },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.assignTelephonyExtension, input, options),
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
    /** Close a conversation; a new message reopens it. */
    closeInboxConversation: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.closeInboxConversation, input, options),
    /** Close a month, locking every date up to its end. */
    closePeriod: (
      input: { readonly body: ClosePeriodInput },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.closePeriod, input, options),
    /** Finish moving two-step sign-in with the new phone's code; the old phone stops working. */
    confirmTwoFactorReplacement: (
      input: { readonly body: ReplacementCode },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.confirmTwoFactorReplacement, input, options),
    /** Count one use of a saved reply (inserted into a reply). */
    countSavedReplyUse: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.countSavedReplyUse, input, options),
    /** Raise an approval request for a money-moving action. */
    createApproval: (
      input: { readonly body: ApprovalRequestInput },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.createApproval, input, options),
    /** Test fixture for the permission matrix. Not deployed to production. */
    createDemoCostedItem: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.createDemoCostedItem, undefined, options),
    /** Add a saved reply: a title, a shortcut typed after /, a body in any language. */
    createSavedReply: (
      input: { readonly body: SavedReplyInput },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.createSavedReply, input, options),
    /** Add an Envo connection; the API key and webhook secret are sealed, write-only. */
    createTelephonyConnection: (
      input: { readonly body: TelephonyConnectionCreateInput },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.createTelephonyConnection, input, options),
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
    /** Decline an offered order; it goes to the next person. */
    declineOrderOffer: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.declineOrderOffer, input, options),
    /** Delete a packing camera from use; past videos keep playing. */
    deletePackingCamera: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.deletePackingCamera, input, options),
    /** Delete a saved reply. */
    deleteSavedReply: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.deleteSavedReply, input, options),
    /** DELETE /v1/catalog/attributes/:id */
    deleteV1CatalogAttributesById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.deleteV1CatalogAttributesById, input, options),
    /** DELETE /v1/catalog/attributes/:id/values/:valueId */
    deleteV1CatalogAttributesByIdValuesByValueId: (
      input: { readonly path: { readonly id: string; readonly valueId: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.deleteV1CatalogAttributesByIdValuesByValueId, input, options),
    /** DELETE /v1/catalog/categories/:id */
    deleteV1CatalogCategoriesById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.deleteV1CatalogCategoriesById, input, options),
    /** DELETE /v1/catalog/products/:id */
    deleteV1CatalogProductsById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.deleteV1CatalogProductsById, input, options),
    /** DELETE /v1/catalog/products/:id/images/:imageId */
    deleteV1CatalogProductsByIdImagesByImageId: (
      input: { readonly path: { readonly id: string; readonly imageId: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.deleteV1CatalogProductsByIdImagesByImageId, input, options),
    /** DELETE /v1/catalog/skus/:id */
    deleteV1CatalogSkusById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.deleteV1CatalogSkusById, input, options),
    /** DELETE /v1/hr/payroll/runs/:id/inputs/:inputId */
    deleteV1HrPayrollRunsByIdInputsByInputId: (
      input: { readonly path: { readonly id: string; readonly inputId: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.deleteV1HrPayrollRunsByIdInputsByInputId, input, options),
    /** DELETE /v1/inventory/locations/:id */
    deleteV1InventoryLocationsById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.deleteV1InventoryLocationsById, input, options),
    /** DELETE /v1/inventory/stock-in-hand/drafts/:id */
    deleteV1InventoryStockInHandDraftsById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.deleteV1InventoryStockInHandDraftsById, input, options),
    /** DELETE /v1/labels/printers/:id */
    deleteV1LabelsPrintersById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.deleteV1LabelsPrintersById, input, options),
    /** DELETE /v1/marketing/campaigns/:id */
    deleteV1MarketingCampaignsById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.deleteV1MarketingCampaignsById, input, options),
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
    /** DELETE /v1/notify/templates/:id */
    deleteV1NotifyTemplatesById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.deleteV1NotifyTemplatesById, input, options),
    /** DELETE /v1/promo/codes/:id */
    deleteV1PromoCodesById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.deleteV1PromoCodesById, input, options),
    /** DELETE /v1/promo/flash-sales/:id */
    deleteV1PromoFlashSalesById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.deleteV1PromoFlashSalesById, input, options),
    /** DELETE /v1/storefront/campaign-links/:id */
    deleteV1StorefrontCampaignLinksById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.deleteV1StorefrontCampaignLinksById, input, options),
    /** DELETE /v1/storefront/hero-slides/:id */
    deleteV1StorefrontHeroSlidesById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.deleteV1StorefrontHeroSlidesById, input, options),
    /** DELETE /v1/storefront/nav-items/:id */
    deleteV1StorefrontNavItemsById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.deleteV1StorefrontNavItemsById, input, options),
    /** DELETE /v1/storefront/size-charts/:id */
    deleteV1StorefrontSizeChartsById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.deleteV1StorefrontSizeChartsById, input, options),
    /** DELETE /v1/supply/drafts/:id */
    deleteV1SupplyDraftsById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.deleteV1SupplyDraftsById, input, options),
    /** DELETE /v1/supply/suppliers/:id */
    deleteV1SupplySuppliersById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.deleteV1SupplySuppliersById, input, options),
    /** DELETE /v1/telephony/connections/:id/extensions/:extension */
    deleteV1TelephonyConnectionsByIdExtensionsByExtension: (
      input: { readonly path: { readonly extension: string; readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(
        runtime,
        OPERATIONS.deleteV1TelephonyConnectionsByIdExtensionsByExtension,
        input,
        options,
      ),
    /** Sign out every device but this one. */
    endMyOtherSessions: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.endMyOtherSessions, undefined, options),
    /** Sign one of your other devices out. */
    endMySession: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.endMySession, input, options),
    /** GET /api/admin/scanner/shipment */
    getApiAdminScannerShipment: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getApiAdminScannerShipment, undefined, options),
    /** One approval request, with its decision lineage. */
    getApproval: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.getApproval, input, options),
    /** A conversation, its reply window, and its messages (older pages by `before`). */
    getInboxConversation: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.getInboxConversation, input, options),
    /** The order desk's new-order form, prefilled from the chat. */
    getInboxOrderDraft: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.getInboxOrderDraft, input, options),
    /** The customer panel: phones found in the chat, the address, the matched customer and their orders, notes, interests, tags and stage. */
    getInboxPanel: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.getInboxPanel, input, options),
    /** Whether a phone belongs to a contact marked fraud, for the order desk. */
    getInboxPhoneFlags: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getInboxPhoneFlags, undefined, options),
    /** GET /media/:orgId/:fileId/:variant */
    getMediaByOrgIdByFileIdByVariant: (
      input: {
        readonly path: {
          readonly fileId: string;
          readonly orgId: string;
          readonly variant: string;
        };
      },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.getMediaByOrgIdByFileIdByVariant, input, options),
    /** Your name, roles here, and two-step sign-in: on or off, and whether it is required. */
    getMyAccount: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getMyAccount, undefined, options),
    /** Your presence and your desk profile. */
    getMyDesk: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getMyDesk, undefined, options),
    /** GET /ncom/:orgId/v1 */
    getNcomByOrgIdV1: (
      input: { readonly path: { readonly orgId: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.getNcomByOrgIdV1, input, options),
    /** GET /ncom/:orgId/v1/categories */
    getNcomByOrgIdV1Categories: (
      input: { readonly path: { readonly orgId: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.getNcomByOrgIdV1Categories, input, options),
    /** GET /ncom/:orgId/v1/ping */
    getNcomByOrgIdV1Ping: (
      input: { readonly path: { readonly orgId: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.getNcomByOrgIdV1Ping, input, options),
    /** GET /ncom/:orgId/v1/products */
    getNcomByOrgIdV1Products: (
      input: { readonly path: { readonly orgId: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.getNcomByOrgIdV1Products, input, options),
    /** GET /ncom/:orgId/v1/products/:id */
    getNcomByOrgIdV1ProductsById: (
      input: { readonly path: { readonly id: string; readonly orgId: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.getNcomByOrgIdV1ProductsById, input, options),
    /** GET /storefront/v1/accounts/:id */
    getStorefrontV1AccountsById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.getStorefrontV1AccountsById, input, options),
    /** GET /storefront/v1/accounts/:id/orders */
    getStorefrontV1AccountsByIdOrders: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.getStorefrontV1AccountsByIdOrders, input, options),
    /** GET /storefront/v1/accounts/:id/orders/:orderNo */
    getStorefrontV1AccountsByIdOrdersByOrderNo: (
      input: { readonly path: { readonly id: string; readonly orderNo: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.getStorefrontV1AccountsByIdOrdersByOrderNo, input, options),
    /** GET /storefront/v1/catalog/categories */
    getStorefrontV1CatalogCategories: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getStorefrontV1CatalogCategories, undefined, options),
    /** GET /storefront/v1/catalog/products */
    getStorefrontV1CatalogProducts: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getStorefrontV1CatalogProducts, undefined, options),
    /** GET /storefront/v1/catalog/products/:slug */
    getStorefrontV1CatalogProductsBySlug: (
      input: { readonly path: { readonly slug: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.getStorefrontV1CatalogProductsBySlug, input, options),
    /** GET /storefront/v1/catalog/search */
    getStorefrontV1CatalogSearch: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getStorefrontV1CatalogSearch, undefined, options),
    /** GET /storefront/v1/custom-links/:code */
    getStorefrontV1CustomLinksByCode: (
      input: { readonly path: { readonly code: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.getStorefrontV1CustomLinksByCode, input, options),
    /** GET /storefront/v1/flash-sales */
    getStorefrontV1FlashSales: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getStorefrontV1FlashSales, undefined, options),
    /** GET /storefront/v1/flash-sales/:slug */
    getStorefrontV1FlashSalesBySlug: (
      input: { readonly path: { readonly slug: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.getStorefrontV1FlashSalesBySlug, input, options),
    /** GET /storefront/v1/geo/districts */
    getStorefrontV1GeoDistricts: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getStorefrontV1GeoDistricts, undefined, options),
    /** GET /storefront/v1/geo/thanas */
    getStorefrontV1GeoThanas: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getStorefrontV1GeoThanas, undefined, options),
    /** GET /storefront/v1/orders/:orderNo */
    getStorefrontV1OrdersByOrderNo: (
      input: { readonly path: { readonly orderNo: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.getStorefrontV1OrdersByOrderNo, input, options),
    /** GET /storefront/v1/site */
    getStorefrontV1Site: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getStorefrontV1Site, undefined, options),
    /** GET /storefront/v1/size-charts/:id */
    getStorefrontV1SizeChartsById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.getStorefrontV1SizeChartsById, input, options),
    /** GET /storefront/v1/tracking/config */
    getStorefrontV1TrackingConfig: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getStorefrontV1TrackingConfig, undefined, options),
    /** Which roles must use two-step sign-in in this brand (super admins only). */
    getTwoFactorPolicy: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getTwoFactorPolicy, undefined, options),
    /** GET /v1/accounts/cash-entries */
    getV1AccountsCashEntries: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1AccountsCashEntries, undefined, options),
    /** GET /v1/accounts/categories */
    getV1AccountsCategories: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1AccountsCategories, undefined, options),
    /** GET /v1/accounts/closings */
    getV1AccountsClosings: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1AccountsClosings, undefined, options),
    /** GET /v1/accounts/heads */
    getV1AccountsHeads: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1AccountsHeads, undefined, options),
    /** GET /v1/accounts/reports/aging */
    getV1AccountsReportsAging: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1AccountsReportsAging, undefined, options),
    /** GET /v1/accounts/reports/balance-sheet */
    getV1AccountsReportsBalanceSheet: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1AccountsReportsBalanceSheet, undefined, options),
    /** GET /v1/accounts/reports/profit-and-loss */
    getV1AccountsReportsProfitAndLoss: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1AccountsReportsProfitAndLoss, undefined, options),
    /** GET /v1/accounts/wallets */
    getV1AccountsWallets: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1AccountsWallets, undefined, options),
    /** GET /v1/analytics/dashboard */
    getV1AnalyticsDashboard: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1AnalyticsDashboard, undefined, options),
    /** GET /v1/analytics/export */
    getV1AnalyticsExport: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1AnalyticsExport, undefined, options),
    /** GET /v1/analytics/insights */
    getV1AnalyticsInsights: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1AnalyticsInsights, undefined, options),
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
    /** GET /v1/catalog/attributes/:id/usage */
    getV1CatalogAttributesByIdUsage: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1CatalogAttributesByIdUsage, input, options),
    /** GET /v1/catalog/attributes/:id/values/:valueId/usage */
    getV1CatalogAttributesByIdValuesByValueIdUsage: (
      input: { readonly path: { readonly id: string; readonly valueId: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1CatalogAttributesByIdValuesByValueIdUsage, input, options),
    /** GET /v1/catalog/categories */
    getV1CatalogCategories: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1CatalogCategories, undefined, options),
    /** GET /v1/catalog/categories/:id/usage */
    getV1CatalogCategoriesByIdUsage: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1CatalogCategoriesByIdUsage, input, options),
    /** GET /v1/catalog/lookup */
    getV1CatalogLookup: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1CatalogLookup, undefined, options),
    /** GET /v1/catalog/products */
    getV1CatalogProducts: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1CatalogProducts, undefined, options),
    /** GET /v1/catalog/products/:id */
    getV1CatalogProductsById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.getV1CatalogProductsById, input, options),
    /** GET /v1/catalog/products/:id/price-history */
    getV1CatalogProductsByIdPriceHistory: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1CatalogProductsByIdPriceHistory, input, options),
    /** GET /v1/catalog/products/:id/usage */
    getV1CatalogProductsByIdUsage: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1CatalogProductsByIdUsage, input, options),
    /** GET /v1/catalog/skus */
    getV1CatalogSkus: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1CatalogSkus, undefined, options),
    /** GET /v1/catalog/skus/:id/price-history */
    getV1CatalogSkusByIdPriceHistory: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1CatalogSkusByIdPriceHistory, input, options),
    /** GET /v1/catalog/skus/:id/usage */
    getV1CatalogSkusByIdUsage: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.getV1CatalogSkusByIdUsage, input, options),
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
    /** GET /v1/hr/branch-options */
    getV1HrBranchOptions: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1HrBranchOptions, undefined, options),
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
    /** GET /v1/hr/login-options */
    getV1HrLoginOptions: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1HrLoginOptions, undefined, options),
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
    /** GET /v1/inbox/calls/:id */
    getV1InboxCallsById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.getV1InboxCallsById, input, options),
    /** GET /v1/inbox/calls/live */
    getV1InboxCallsLive: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1InboxCallsLive, undefined, options),
    /** GET /v1/inbox/media/:fileId */
    getV1InboxMediaByFileId: (
      input: { readonly path: { readonly fileId: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.getV1InboxMediaByFileId, input, options),
    /** GET /v1/inbox/offers/mine */
    getV1InboxOffersMine: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1InboxOffersMine, undefined, options),
    /** GET /v1/inbox/products */
    getV1InboxProducts: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1InboxProducts, undefined, options),
    /** GET /v1/inbox/selling-context */
    getV1InboxSellingContext: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1InboxSellingContext, undefined, options),
    /** GET /v1/inbox/size-charts/:id */
    getV1InboxSizeChartsById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.getV1InboxSizeChartsById, input, options),
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
    /** GET /v1/inventory/locations/:id/usage */
    getV1InventoryLocationsByIdUsage: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1InventoryLocationsByIdUsage, input, options),
    /** GET /v1/inventory/movements */
    getV1InventoryMovements: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1InventoryMovements, undefined, options),
    /** GET /v1/inventory/reconciliations */
    getV1InventoryReconciliations: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1InventoryReconciliations, undefined, options),
    /** GET /v1/inventory/stock */
    getV1InventoryStock: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1InventoryStock, undefined, options),
    /** GET /v1/inventory/stock-in-hand */
    getV1InventoryStockInHand: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1InventoryStockInHand, undefined, options),
    /** GET /v1/inventory/stock-in-hand/:id */
    getV1InventoryStockInHandById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1InventoryStockInHandById, input, options),
    /** GET /v1/inventory/stock-in-hand/window */
    getV1InventoryStockInHandWindow: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1InventoryStockInHandWindow, undefined, options),
    /** GET /v1/inventory/stock/products */
    getV1InventoryStockProducts: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1InventoryStockProducts, undefined, options),
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
    /** GET /v1/investors/login-options */
    getV1InvestorsLoginOptions: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1InvestorsLoginOptions, undefined, options),
    /** GET /v1/investors/wallet-accounts */
    getV1InvestorsWalletAccounts: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1InvestorsWalletAccounts, undefined, options),
    /** GET /v1/investors/withdrawals */
    getV1InvestorsWithdrawals: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1InvestorsWithdrawals, undefined, options),
    /** GET /v1/jobs/failed */
    getV1JobsFailed: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1JobsFailed, undefined, options),
    /** GET /v1/labels/jobs */
    getV1LabelsJobs: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1LabelsJobs, undefined, options),
    /** GET /v1/labels/jobs/export */
    getV1LabelsJobsExport: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1LabelsJobsExport, undefined, options),
    /** GET /v1/labels/orders/:orderId */
    getV1LabelsOrdersByOrderId: (
      input: { readonly path: { readonly orderId: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.getV1LabelsOrdersByOrderId, input, options),
    /** GET /v1/labels/printers */
    getV1LabelsPrinters: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1LabelsPrinters, undefined, options),
    /** GET /v1/labels/ready */
    getV1LabelsReady: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1LabelsReady, undefined, options),
    /** GET /v1/labels/settings */
    getV1LabelsSettings: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1LabelsSettings, undefined, options),
    /** GET /v1/labels/station/jobs */
    getV1LabelsStationJobs: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1LabelsStationJobs, undefined, options),
    /** GET /v1/labels/station/jobs/:id/document */
    getV1LabelsStationJobsByIdDocument: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1LabelsStationJobsByIdDocument, input, options),
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
    /** GET /v1/marketing/campaigns/:id/usage */
    getV1MarketingCampaignsByIdUsage: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1MarketingCampaignsByIdUsage, input, options),
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
    /** GET /v1/marketplace/ncom */
    getV1MarketplaceNcom: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1MarketplaceNcom, undefined, options),
    /** GET /v1/marketplace/ncom/holds */
    getV1MarketplaceNcomHolds: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1MarketplaceNcomHolds, undefined, options),
    /** GET /v1/marketplace/ncom/orders */
    getV1MarketplaceNcomOrders: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1MarketplaceNcomOrders, undefined, options),
    /** GET /v1/notify/messages */
    getV1NotifyMessages: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1NotifyMessages, undefined, options),
    /** GET /v1/notify/opt-outs */
    getV1NotifyOptOuts: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1NotifyOptOuts, undefined, options),
    /** GET /v1/notify/templates */
    getV1NotifyTemplates: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1NotifyTemplates, undefined, options),
    /** GET /v1/notify/templates/:id/usage */
    getV1NotifyTemplatesByIdUsage: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1NotifyTemplatesByIdUsage, input, options),
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
    /** GET /v1/packing/handover */
    getV1PackingHandover: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1PackingHandover, undefined, options),
    /** GET /v1/packing/orders/:orderId */
    getV1PackingOrdersByOrderId: (
      input: { readonly path: { readonly orderId: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.getV1PackingOrdersByOrderId, input, options),
    /** GET /v1/packing/sessions */
    getV1PackingSessions: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1PackingSessions, undefined, options),
    /** GET /v1/packing/sessions/:id */
    getV1PackingSessionsById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.getV1PackingSessionsById, input, options),
    /** GET /v1/packing/settings */
    getV1PackingSettings: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1PackingSettings, undefined, options),
    /** GET /v1/packing/videos/:id/url */
    getV1PackingVideosByIdUrl: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.getV1PackingVideosByIdUrl, input, options),
    /** GET /v1/pos/branches */
    getV1PosBranches: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1PosBranches, undefined, options),
    /** GET /v1/pos/branches/:id/closings */
    getV1PosBranchesByIdClosings: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1PosBranchesByIdClosings, input, options),
    /** GET /v1/pos/branches/:id/holds */
    getV1PosBranchesByIdHolds: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.getV1PosBranchesByIdHolds, input, options),
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
    /** GET /v1/promo/codes/:id/usage */
    getV1PromoCodesByIdUsage: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.getV1PromoCodesByIdUsage, input, options),
    /** GET /v1/promo/flash-sales */
    getV1PromoFlashSales: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1PromoFlashSales, undefined, options),
    /** GET /v1/promo/flash-sales/:id */
    getV1PromoFlashSalesById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.getV1PromoFlashSalesById, input, options),
    /** GET /v1/promo/flash-sales/:id/usage */
    getV1PromoFlashSalesByIdUsage: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1PromoFlashSalesByIdUsage, input, options),
    /** GET /v1/scanner/devices */
    getV1ScannerDevices: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1ScannerDevices, undefined, options),
    /** GET /v1/scanner/lookup */
    getV1ScannerLookup: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1ScannerLookup, undefined, options),
    /** GET /v1/scanner/shipment */
    getV1ScannerShipment: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1ScannerShipment, undefined, options),
    /** GET /v1/storefront/accounts */
    getV1StorefrontAccounts: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1StorefrontAccounts, undefined, options),
    /** GET /v1/storefront/campaign-links */
    getV1StorefrontCampaignLinks: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1StorefrontCampaignLinks, undefined, options),
    /** GET /v1/storefront/campaign-links/:id */
    getV1StorefrontCampaignLinksById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1StorefrontCampaignLinksById, input, options),
    /** GET /v1/storefront/email */
    getV1StorefrontEmail: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1StorefrontEmail, undefined, options),
    /** GET /v1/storefront/email/log */
    getV1StorefrontEmailLog: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1StorefrontEmailLog, undefined, options),
    /** GET /v1/storefront/hero-slides */
    getV1StorefrontHeroSlides: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1StorefrontHeroSlides, undefined, options),
    /** GET /v1/storefront/nav-items */
    getV1StorefrontNavItems: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1StorefrontNavItems, undefined, options),
    /** GET /v1/storefront/nav-items/:id/usage */
    getV1StorefrontNavItemsByIdUsage: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1StorefrontNavItemsByIdUsage, input, options),
    /** GET /v1/storefront/orders/:orderId */
    getV1StorefrontOrdersByOrderId: (
      input: { readonly path: { readonly orderId: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1StorefrontOrdersByOrderId, input, options),
    /** GET /v1/storefront/payments */
    getV1StorefrontPayments: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1StorefrontPayments, undefined, options),
    /** GET /v1/storefront/payments/sessions */
    getV1StorefrontPaymentsSessions: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1StorefrontPaymentsSessions, undefined, options),
    /** GET /v1/storefront/settings */
    getV1StorefrontSettings: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1StorefrontSettings, undefined, options),
    /** GET /v1/storefront/site-keys */
    getV1StorefrontSiteKeys: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1StorefrontSiteKeys, undefined, options),
    /** GET /v1/storefront/size-charts */
    getV1StorefrontSizeCharts: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1StorefrontSizeCharts, undefined, options),
    /** GET /v1/storefront/size-charts/:id/usage */
    getV1StorefrontSizeChartsByIdUsage: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1StorefrontSizeChartsByIdUsage, input, options),
    /** GET /v1/storefront/tracking */
    getV1StorefrontTracking: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1StorefrontTracking, undefined, options),
    /** GET /v1/storefront/tracking/events */
    getV1StorefrontTrackingEvents: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1StorefrontTrackingEvents, undefined, options),
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
    /** GET /v1/supply/sku-costs */
    getV1SupplySkuCosts: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1SupplySkuCosts, undefined, options),
    /** GET /v1/supply/sku-costs/export */
    getV1SupplySkuCostsExport: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1SupplySkuCostsExport, undefined, options),
    /** GET /v1/supply/supplier-options */
    getV1SupplySupplierOptions: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1SupplySupplierOptions, undefined, options),
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
    /** GET /v1/supply/suppliers/:id/usage */
    getV1SupplySuppliersByIdUsage: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1SupplySuppliersByIdUsage, input, options),
    /** GET /v1/telephony/assignments */
    getV1TelephonyAssignments: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1TelephonyAssignments, undefined, options),
    /** GET /v1/telephony/calls */
    getV1TelephonyCalls: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1TelephonyCalls, undefined, options),
    /** GET /v1/telephony/calls/:id */
    getV1TelephonyCallsById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.getV1TelephonyCallsById, input, options),
    /** GET /v1/telephony/calls/:id/recording */
    getV1TelephonyCallsByIdRecording: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1TelephonyCallsByIdRecording, input, options),
    /** GET /v1/telephony/calls/wrap-ups */
    getV1TelephonyCallsWrapUps: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1TelephonyCallsWrapUps, undefined, options),
    /** GET /v1/telephony/connections/:id/extensions */
    getV1TelephonyConnectionsByIdExtensions: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1TelephonyConnectionsByIdExtensions, input, options),
    /** GET /v1/telephony/connections/:id/live */
    getV1TelephonyConnectionsByIdLive: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1TelephonyConnectionsByIdLive, input, options),
    /** GET /v1/telephony/me */
    getV1TelephonyMe: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1TelephonyMe, undefined, options),
    /** GET /v1/telephony/phone/token */
    getV1TelephonyPhoneToken: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1TelephonyPhoneToken, undefined, options),
    /** GET /v1/terminals */
    getV1Terminals: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1Terminals, undefined, options),
    /** GET /webhooks/meta/:orgId */
    getWebhooksMetaByOrgId: (
      input: { readonly path: { readonly orgId: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.getWebhooksMetaByOrgId, input, options),
    /** Auto-assign, the offer countdown and the cap on open orders per person. */
    getWorkflowSettings: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getWorkflowSettings, undefined, options),
    /** Hand a conversation to a colleague; someone else's is a supervisor's. */
    handOverInboxConversation: (
      input: { readonly path: { readonly id: string }; readonly body: InboxHandOverInput },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.handOverInboxConversation, input, options),
    /** Liveness probe. */
    healthLive: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.healthLive, undefined, options),
    /** Readiness probe. */
    healthReady: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.healthReady, undefined, options),
    /** Unread messages in the caller's open conversations and in open ones nobody has. */
    inboxUnreadCounts: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.inboxUnreadCounts, undefined, options),
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
    /** Every staff member's work types and hub, with their presence. */
    listDeskProfiles: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.listDeskProfiles, undefined, options),
    /** Settings → Inbox: each channel's id and whether its token is set (never the token). */
    listInboxChannels: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.listInboxChannels, undefined, options),
    /** Every channel in one list: mine, unassigned or all, by channel, stage and unread. */
    listInboxConversations: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.listInboxConversations, undefined, options),
    /** Who can be handed a conversation: active sales and org admins. */
    listInboxTeam: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.listInboxTeam, undefined, options),
    /** The chart of accounts visible to this caller. */
    listLedgerAccounts: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.listLedgerAccounts, undefined, options),
    /** The organizations this user may enter. */
    listMyOrgs: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.listMyOrgs, undefined, options),
    /** The devices you are signed in on, with the address partly hidden. */
    listMySessions: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.listMySessions, undefined, options),
    /** An order's verification calls, newest first. */
    listOrderCalls: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.listOrderCalls, input, options),
    /** The packing tables' IP cameras and whether each is filming now. */
    listPackingCameras: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.listPackingCameras, undefined, options),
    /** Accounting periods and whether each is closed. */
    listPeriods: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.listPeriods, undefined, options),
    /** The brand's saved replies, the most used first. */
    listSavedReplies: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.listSavedReplies, undefined, options),
    /** The brand's Envo connections: never a secret, only whether it is set and its print. */
    listTelephonyConnections: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.listTelephonyConnections, undefined, options),
    /** This organization's staff, their roles and sign-in state, and open resets. */
    listUsers: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.listUsers, undefined, options),
    /** Cash, bank and mobile-money wallets with their balances. */
    listWallets: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.listWallets, undefined, options),
    /** The brand name and logo for the login screen, chosen by hostname. */
    loginBranding: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.loginBranding, undefined, options),
    /** Record one verification call to the buyer. */
    logOrderCall: (
      input: { readonly path: { readonly id: string }; readonly body: CallAttemptInput },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.logOrderCall, input, options),
    /** Who is calling: the buyer a number names (only one the caller may open, or whose call is on the caller's phone now) and their open orders. */
    lookupPhoneCaller: (
      input: { readonly body: unknown },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.lookupPhoneCaller, input, options),
    /** The hub printed these confirmed orders' slips. */
    markSlipsPrinted: (
      input: { readonly body: MarkPrintedInput },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.markSlipsPrinted, input, options),
    /** The signed-in user, their roles and active org. */
    me: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.me, undefined, options),
    /** The orders offered to you right now, with their countdown. */
    myOrderOffers: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.myOrderOffers, undefined, options),
    /** With your password and a current authenticator code, make ten new recovery codes; the old ones stop working. */
    newMyRecoveryCodes: (
      input: { readonly body: ConfirmWithCode },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.newMyRecoveryCodes, input, options),
    /** The newest JPEG frame of a packing camera's live preview; 204 when none is live. */
    packingCameraPreview: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.packingCameraPreview, input, options),
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
    /** PATCH /storefront/v1/accounts/:id */
    patchStorefrontV1AccountsById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.patchStorefrontV1AccountsById, input, options),
    /** PATCH /v1/accounts/heads/:id */
    patchV1AccountsHeadsById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.patchV1AccountsHeadsById, input, options),
    /** PATCH /v1/accounts/wallets/:id */
    patchV1AccountsWalletsById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.patchV1AccountsWalletsById, input, options),
    /** PATCH /v1/catalog/attributes/:id */
    patchV1CatalogAttributesById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.patchV1CatalogAttributesById, input, options),
    /** PATCH /v1/catalog/attributes/:id/values/:valueId */
    patchV1CatalogAttributesByIdValuesByValueId: (
      input: { readonly path: { readonly id: string; readonly valueId: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.patchV1CatalogAttributesByIdValuesByValueId, input, options),
    /** PATCH /v1/catalog/categories/:id */
    patchV1CatalogCategoriesById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.patchV1CatalogCategoriesById, input, options),
    /** PATCH /v1/catalog/products */
    patchV1CatalogProducts: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.patchV1CatalogProducts, undefined, options),
    /** PATCH /v1/catalog/products/:id */
    patchV1CatalogProductsById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.patchV1CatalogProductsById, input, options),
    /** PATCH /v1/catalog/skus */
    patchV1CatalogSkus: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.patchV1CatalogSkus, undefined, options),
    /** PATCH /v1/catalog/skus/:id */
    patchV1CatalogSkusById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.patchV1CatalogSkusById, input, options),
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
    /** PATCH /v1/inventory/stock-in-hand/drafts/:id */
    patchV1InventoryStockInHandDraftsById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.patchV1InventoryStockInHandDraftsById, input, options),
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
    /** PATCH /v1/pos/branches/:id */
    patchV1PosBranchesById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.patchV1PosBranchesById, input, options),
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
    /** PATCH /v1/promo/flash-sales/:id */
    patchV1PromoFlashSalesById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.patchV1PromoFlashSalesById, input, options),
    /** PATCH /v1/storefront/settings */
    patchV1StorefrontSettings: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.patchV1StorefrontSettings, undefined, options),
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
    /** A buyer's caller panel by phone, customer or call: their orders, contacts, inbox and every call with them (the whole panel only to a supervisor, a person who may open them or one on a call with them). */
    phoneCallerPanel: (
      input: { readonly body: CallerPanelQuery },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.phoneCallerPanel, input, options),
    /** Pin a note on top of a buyer's caller panel, or clear it with an empty body. */
    pinCustomerNote: (
      input: { readonly path: { readonly id: string }; readonly body: CustomerPinnedNoteInput },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.pinCustomerNote, input, options),
    /** Call a customer from your own extension; an order or a conversation held by someone else needs x-acknowledge-owner: 1. */
    placePhoneCall: (
      input: { readonly body: PhoneCallPlaceInput },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.placePhoneCall, input, options),
    /** POST /api/admin/scanner/login */
    postApiAdminScannerLogin: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postApiAdminScannerLogin, undefined, options),
    /** POST /ncom/:orgId/orders */
    postNcomByOrgIdOrders: (
      input: { readonly path: { readonly orgId: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.postNcomByOrgIdOrders, input, options),
    /** POST /ncom/:orgId/v1/release */
    postNcomByOrgIdV1Release: (
      input: { readonly path: { readonly orgId: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.postNcomByOrgIdV1Release, input, options),
    /** POST /ncom/:orgId/v1/reserve */
    postNcomByOrgIdV1Reserve: (
      input: { readonly path: { readonly orgId: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.postNcomByOrgIdV1Reserve, input, options),
    /** POST /ncom/:orgId/v1/stock */
    postNcomByOrgIdV1Stock: (
      input: { readonly path: { readonly orgId: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.postNcomByOrgIdV1Stock, input, options),
    /** POST /ncom/:orgId/webhook */
    postNcomByOrgIdWebhook: (
      input: { readonly path: { readonly orgId: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.postNcomByOrgIdWebhook, input, options),
    /** POST /public/v1/orders */
    postPublicV1Orders: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postPublicV1Orders, undefined, options),
    /** POST /storefront/ipn/sslcommerz/:orgId */
    postStorefrontIpnSslcommerzByOrgId: (
      input: { readonly path: { readonly orgId: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postStorefrontIpnSslcommerzByOrgId, input, options),
    /** POST /storefront/v1/accounts/:id/change-password */
    postStorefrontV1AccountsByIdChangePassword: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postStorefrontV1AccountsByIdChangePassword, input, options),
    /** POST /storefront/v1/accounts/forgot-password */
    postStorefrontV1AccountsForgotPassword: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postStorefrontV1AccountsForgotPassword, undefined, options),
    /** POST /storefront/v1/accounts/google */
    postStorefrontV1AccountsGoogle: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postStorefrontV1AccountsGoogle, undefined, options),
    /** POST /storefront/v1/accounts/register */
    postStorefrontV1AccountsRegister: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postStorefrontV1AccountsRegister, undefined, options),
    /** POST /storefront/v1/accounts/resend-code */
    postStorefrontV1AccountsResendCode: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postStorefrontV1AccountsResendCode, undefined, options),
    /** POST /storefront/v1/accounts/reset-password */
    postStorefrontV1AccountsResetPassword: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postStorefrontV1AccountsResetPassword, undefined, options),
    /** POST /storefront/v1/accounts/sign-in */
    postStorefrontV1AccountsSignIn: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postStorefrontV1AccountsSignIn, undefined, options),
    /** POST /storefront/v1/accounts/verify-email */
    postStorefrontV1AccountsVerifyEmail: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postStorefrontV1AccountsVerifyEmail, undefined, options),
    /** POST /storefront/v1/cart/quote */
    postStorefrontV1CartQuote: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postStorefrontV1CartQuote, undefined, options),
    /** POST /storefront/v1/checkout */
    postStorefrontV1Checkout: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postStorefrontV1Checkout, undefined, options),
    /** POST /storefront/v1/custom-links/:code/views */
    postStorefrontV1CustomLinksByCodeViews: (
      input: { readonly path: { readonly code: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postStorefrontV1CustomLinksByCodeViews, input, options),
    /** POST /storefront/v1/events */
    postStorefrontV1Events: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postStorefrontV1Events, undefined, options),
    /** POST /storefront/v1/payments/sslcommerz/init */
    postStorefrontV1PaymentsSslcommerzInit: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postStorefrontV1PaymentsSslcommerzInit, undefined, options),
    /** POST /storefront/v1/payments/sslcommerz/return */
    postStorefrontV1PaymentsSslcommerzReturn: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postStorefrontV1PaymentsSslcommerzReturn, undefined, options),
    /** POST /v1/accounts/cash-entries */
    postV1AccountsCashEntries: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1AccountsCashEntries, undefined, options),
    /** POST /v1/accounts/closings */
    postV1AccountsClosings: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1AccountsClosings, undefined, options),
    /** POST /v1/accounts/heads */
    postV1AccountsHeads: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1AccountsHeads, undefined, options),
    /** POST /v1/accounts/transfers */
    postV1AccountsTransfers: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1AccountsTransfers, undefined, options),
    /** POST /v1/accounts/wallets */
    postV1AccountsWallets: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1AccountsWallets, undefined, options),
    /** POST /v1/analytics/rollups/refresh */
    postV1AnalyticsRollupsRefresh: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1AnalyticsRollupsRefresh, undefined, options),
    /** POST /v1/auth/owner-link */
    postV1AuthOwnerLink: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1AuthOwnerLink, undefined, options),
    /** POST /v1/catalog/attributes */
    postV1CatalogAttributes: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1CatalogAttributes, undefined, options),
    /** POST /v1/catalog/attributes/:id/archive */
    postV1CatalogAttributesByIdArchive: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1CatalogAttributesByIdArchive, input, options),
    /** POST /v1/catalog/attributes/:id/restore */
    postV1CatalogAttributesByIdRestore: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1CatalogAttributesByIdRestore, input, options),
    /** POST /v1/catalog/attributes/:id/values */
    postV1CatalogAttributesByIdValues: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1CatalogAttributesByIdValues, input, options),
    /** POST /v1/catalog/attributes/:id/values/:valueId/archive */
    postV1CatalogAttributesByIdValuesByValueIdArchive: (
      input: { readonly path: { readonly id: string; readonly valueId: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(
        runtime,
        OPERATIONS.postV1CatalogAttributesByIdValuesByValueIdArchive,
        input,
        options,
      ),
    /** POST /v1/catalog/attributes/:id/values/:valueId/restore */
    postV1CatalogAttributesByIdValuesByValueIdRestore: (
      input: { readonly path: { readonly id: string; readonly valueId: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(
        runtime,
        OPERATIONS.postV1CatalogAttributesByIdValuesByValueIdRestore,
        input,
        options,
      ),
    /** POST /v1/catalog/categories */
    postV1CatalogCategories: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1CatalogCategories, undefined, options),
    /** POST /v1/catalog/categories/:id/archive */
    postV1CatalogCategoriesByIdArchive: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1CatalogCategoriesByIdArchive, input, options),
    /** POST /v1/catalog/categories/:id/empty-and-delete */
    postV1CatalogCategoriesByIdEmptyAndDelete: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1CatalogCategoriesByIdEmptyAndDelete, input, options),
    /** POST /v1/catalog/categories/:id/restore */
    postV1CatalogCategoriesByIdRestore: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1CatalogCategoriesByIdRestore, input, options),
    /** POST /v1/catalog/imports/prices */
    postV1CatalogImportsPrices: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1CatalogImportsPrices, undefined, options),
    /** POST /v1/catalog/imports/prices/dry-run */
    postV1CatalogImportsPricesDryRun: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1CatalogImportsPricesDryRun, undefined, options),
    /** POST /v1/catalog/imports/products */
    postV1CatalogImportsProducts: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1CatalogImportsProducts, undefined, options),
    /** POST /v1/catalog/imports/products/dry-run */
    postV1CatalogImportsProductsDryRun: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1CatalogImportsProductsDryRun, undefined, options),
    /** POST /v1/catalog/labels */
    postV1CatalogLabels: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1CatalogLabels, undefined, options),
    /** POST /v1/catalog/products */
    postV1CatalogProducts: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1CatalogProducts, undefined, options),
    /** POST /v1/catalog/products/:id/duplicate */
    postV1CatalogProductsByIdDuplicate: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1CatalogProductsByIdDuplicate, input, options),
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
    /** POST /v1/catalog/products/duplicate */
    postV1CatalogProductsDuplicate: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1CatalogProductsDuplicate, undefined, options),
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
    /** POST /v1/inbox/calls/:id/answer */
    postV1InboxCallsByIdAnswer: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.postV1InboxCallsByIdAnswer, input, options),
    /** POST /v1/inbox/calls/:id/callback-done */
    postV1InboxCallsByIdCallbackDone: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1InboxCallsByIdCallbackDone, input, options),
    /** POST /v1/inbox/calls/:id/claim */
    postV1InboxCallsByIdClaim: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.postV1InboxCallsByIdClaim, input, options),
    /** POST /v1/inbox/calls/:id/decline */
    postV1InboxCallsByIdDecline: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.postV1InboxCallsByIdDecline, input, options),
    /** POST /v1/inbox/calls/:id/hang-up */
    postV1InboxCallsByIdHangUp: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.postV1InboxCallsByIdHangUp, input, options),
    /** POST /v1/inbox/calls/:id/release */
    postV1InboxCallsByIdRelease: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.postV1InboxCallsByIdRelease, input, options),
    /** POST /v1/inbox/conversations/:id/voice */
    postV1InboxConversationsByIdVoice: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1InboxConversationsByIdVoice, input, options),
    /** POST /v1/inbox/offers/:id/accept */
    postV1InboxOffersByIdAccept: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.postV1InboxOffersByIdAccept, input, options),
    /** POST /v1/inbox/offers/:id/decline */
    postV1InboxOffersByIdDecline: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1InboxOffersByIdDecline, input, options),
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
    /** POST /v1/inventory/counts/:id/scans */
    postV1InventoryCountsByIdScans: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1InventoryCountsByIdScans, input, options),
    /** POST /v1/inventory/counts/:id/submit */
    postV1InventoryCountsByIdSubmit: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1InventoryCountsByIdSubmit, input, options),
    /** POST /v1/inventory/locations */
    postV1InventoryLocations: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1InventoryLocations, undefined, options),
    /** POST /v1/inventory/locations/:id/archive */
    postV1InventoryLocationsByIdArchive: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1InventoryLocationsByIdArchive, input, options),
    /** POST /v1/inventory/locations/:id/restore */
    postV1InventoryLocationsByIdRestore: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1InventoryLocationsByIdRestore, input, options),
    /** POST /v1/inventory/stock-in-hand */
    postV1InventoryStockInHand: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1InventoryStockInHand, undefined, options),
    /** POST /v1/inventory/stock-in-hand/:id/post */
    postV1InventoryStockInHandByIdPost: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1InventoryStockInHandByIdPost, input, options),
    /** POST /v1/inventory/stock-in-hand/:id/reverse */
    postV1InventoryStockInHandByIdReverse: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1InventoryStockInHandByIdReverse, input, options),
    /** POST /v1/inventory/stock-in-hand/drafts */
    postV1InventoryStockInHandDrafts: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1InventoryStockInHandDrafts, undefined, options),
    /** POST /v1/inventory/stock-in-hand/window/close */
    postV1InventoryStockInHandWindowClose: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1InventoryStockInHandWindowClose, undefined, options),
    /** POST /v1/inventory/stock-in-hand/window/reopen */
    postV1InventoryStockInHandWindowReopen: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1InventoryStockInHandWindowReopen, undefined, options),
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
    /** POST /v1/labels/jobs/:id/cancel */
    postV1LabelsJobsByIdCancel: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.postV1LabelsJobsByIdCancel, input, options),
    /** POST /v1/labels/jobs/:id/retry */
    postV1LabelsJobsByIdRetry: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.postV1LabelsJobsByIdRetry, input, options),
    /** POST /v1/labels/print */
    postV1LabelsPrint: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1LabelsPrint, undefined, options),
    /** POST /v1/labels/printers */
    postV1LabelsPrinters: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1LabelsPrinters, undefined, options),
    /** POST /v1/labels/printers/:id/test */
    postV1LabelsPrintersByIdTest: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1LabelsPrintersByIdTest, input, options),
    /** POST /v1/labels/station/jobs/:id/result */
    postV1LabelsStationJobsByIdResult: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1LabelsStationJobsByIdResult, input, options),
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
    /** POST /v1/marketplace/ncom/holds/:id/release */
    postV1MarketplaceNcomHoldsByIdRelease: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1MarketplaceNcomHoldsByIdRelease, input, options),
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
    /** POST /v1/packing/handover */
    postV1PackingHandover: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1PackingHandover, undefined, options),
    /** POST /v1/packing/handover/scans */
    postV1PackingHandoverScans: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1PackingHandoverScans, undefined, options),
    /** POST /v1/packing/labels */
    postV1PackingLabels: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1PackingLabels, undefined, options),
    /** POST /v1/packing/sessions */
    postV1PackingSessions: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1PackingSessions, undefined, options),
    /** POST /v1/packing/sessions/:id/complete */
    postV1PackingSessionsByIdComplete: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1PackingSessionsByIdComplete, input, options),
    /** POST /v1/packing/sessions/:id/lots/close */
    postV1PackingSessionsByIdLotsClose: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1PackingSessionsByIdLotsClose, input, options),
    /** POST /v1/packing/sessions/:id/removals */
    postV1PackingSessionsByIdRemovals: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1PackingSessionsByIdRemovals, input, options),
    /** POST /v1/packing/sessions/:id/scans */
    postV1PackingSessionsByIdScans: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1PackingSessionsByIdScans, input, options),
    /** POST /v1/packing/sessions/:id/videos */
    postV1PackingSessionsByIdVideos: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1PackingSessionsByIdVideos, input, options),
    /** POST /v1/packing/sessions/:id/videos/:videoId/file */
    postV1PackingSessionsByIdVideosByVideoIdFile: (
      input: { readonly path: { readonly id: string; readonly videoId: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1PackingSessionsByIdVideosByVideoIdFile, input, options),
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
    /** POST /v1/promo/codes/:id/restore */
    postV1PromoCodesByIdRestore: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.postV1PromoCodesByIdRestore, input, options),
    /** POST /v1/promo/flash-sales */
    postV1PromoFlashSales: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1PromoFlashSales, undefined, options),
    /** POST /v1/promo/flash-sales/:id/archive */
    postV1PromoFlashSalesByIdArchive: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1PromoFlashSalesByIdArchive, input, options),
    /** POST /v1/promo/flash-sales/:id/duplicate */
    postV1PromoFlashSalesByIdDuplicate: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1PromoFlashSalesByIdDuplicate, input, options),
    /** POST /v1/promo/flash-sales/:id/restore */
    postV1PromoFlashSalesByIdRestore: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1PromoFlashSalesByIdRestore, input, options),
    /** POST /v1/scanner/devices */
    postV1ScannerDevices: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1ScannerDevices, undefined, options),
    /** POST /v1/scanner/devices/:id/revoke */
    postV1ScannerDevicesByIdRevoke: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1ScannerDevicesByIdRevoke, input, options),
    /** POST /v1/scanner/sign-in */
    postV1ScannerSignIn: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1ScannerSignIn, undefined, options),
    /** POST /v1/scanner/sign-out */
    postV1ScannerSignOut: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1ScannerSignOut, undefined, options),
    /** POST /v1/storefront/campaign-links */
    postV1StorefrontCampaignLinks: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1StorefrontCampaignLinks, undefined, options),
    /** POST /v1/storefront/email/test */
    postV1StorefrontEmailTest: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1StorefrontEmailTest, undefined, options),
    /** POST /v1/storefront/hero-slides */
    postV1StorefrontHeroSlides: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1StorefrontHeroSlides, undefined, options),
    /** POST /v1/storefront/nav-items */
    postV1StorefrontNavItems: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1StorefrontNavItems, undefined, options),
    /** POST /v1/storefront/site-keys */
    postV1StorefrontSiteKeys: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1StorefrontSiteKeys, undefined, options),
    /** POST /v1/storefront/site-keys/:id/revoke */
    postV1StorefrontSiteKeysByIdRevoke: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1StorefrontSiteKeysByIdRevoke, input, options),
    /** POST /v1/storefront/size-charts */
    postV1StorefrontSizeCharts: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1StorefrontSizeCharts, undefined, options),
    /** POST /v1/storefront/size-charts/:id/empty-and-delete */
    postV1StorefrontSizeChartsByIdEmptyAndDelete: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1StorefrontSizeChartsByIdEmptyAndDelete, input, options),
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
    /** POST /v1/supply/sku-costs/import */
    postV1SupplySkuCostsImport: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1SupplySkuCostsImport, undefined, options),
    /** POST /v1/supply/sku-costs/import/dry-run */
    postV1SupplySkuCostsImportDryRun: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1SupplySkuCostsImportDryRun, undefined, options),
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
    /** POST /v1/telephony/connections/:id/live/:callId/hangup */
    postV1TelephonyConnectionsByIdLiveByCallIdHangup: (
      input: { readonly path: { readonly callId: string; readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1TelephonyConnectionsByIdLiveByCallIdHangup, input, options),
    /** POST /v1/terminals */
    postV1Terminals: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1Terminals, undefined, options),
    /** POST /v1/terminals/:id/bind */
    postV1TerminalsByIdBind: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.postV1TerminalsByIdBind, input, options),
    /** POST /v1/terminals/check-in */
    postV1TerminalsCheckIn: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1TerminalsCheckIn, undefined, options),
    /** POST /v1/terminals/devices/:id/revoke */
    postV1TerminalsDevicesByIdRevoke: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1TerminalsDevicesByIdRevoke, input, options),
    /** POST /v1/track */
    postV1Track: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1Track, undefined, options),
    /** POST /webhooks/envo/:orgId/:connectionId */
    postWebhooksEnvoByOrgIdByConnectionId: (
      input: { readonly path: { readonly connectionId: string; readonly orgId: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.postWebhooksEnvoByOrgIdByConnectionId, input, options),
    /** POST /webhooks/meta/:orgId */
    postWebhooksMetaByOrgId: (
      input: { readonly path: { readonly orgId: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.postWebhooksMetaByOrgId, input, options),
    /** PUT /v1/catalog/attributes/:id/values/order */
    putV1CatalogAttributesByIdValuesOrder: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.putV1CatalogAttributesByIdValuesOrder, input, options),
    /** PUT /v1/catalog/prices */
    putV1CatalogPrices: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.putV1CatalogPrices, undefined, options),
    /** PUT /v1/catalog/products/:id/images/:imageId/colour */
    putV1CatalogProductsByIdImagesByImageIdColour: (
      input: { readonly path: { readonly id: string; readonly imageId: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.putV1CatalogProductsByIdImagesByImageIdColour, input, options),
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
    /** PUT /v1/catalog/skus/:id/weight */
    putV1CatalogSkusByIdWeight: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.putV1CatalogSkusByIdWeight, input, options),
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
    /** PUT /v1/labels/printers/:id */
    putV1LabelsPrintersById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.putV1LabelsPrintersById, input, options),
    /** PUT /v1/labels/settings */
    putV1LabelsSettings: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.putV1LabelsSettings, undefined, options),
    /** PUT /v1/marketing/meta-connection */
    putV1MarketingMetaConnection: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.putV1MarketingMetaConnection, undefined, options),
    /** PUT /v1/marketing/spend */
    putV1MarketingSpend: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.putV1MarketingSpend, undefined, options),
    /** PUT /v1/marketplace/ncom */
    putV1MarketplaceNcom: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.putV1MarketplaceNcom, undefined, options),
    /** PUT /v1/notify/templates */
    putV1NotifyTemplates: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.putV1NotifyTemplates, undefined, options),
    /** PUT /v1/packing/orders/:orderId/lots */
    putV1PackingOrdersByOrderIdLots: (
      input: { readonly path: { readonly orderId: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.putV1PackingOrdersByOrderIdLots, input, options),
    /** PUT /v1/packing/settings */
    putV1PackingSettings: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.putV1PackingSettings, undefined, options),
    /** PUT /v1/promo/flash-sales/:id */
    putV1PromoFlashSalesById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.putV1PromoFlashSalesById, input, options),
    /** PUT /v1/storefront/campaign-links/:id */
    putV1StorefrontCampaignLinksById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.putV1StorefrontCampaignLinksById, input, options),
    /** PUT /v1/storefront/categories/:id */
    putV1StorefrontCategoriesById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.putV1StorefrontCategoriesById, input, options),
    /** PUT /v1/storefront/email */
    putV1StorefrontEmail: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.putV1StorefrontEmail, undefined, options),
    /** PUT /v1/storefront/hero-slides/:id */
    putV1StorefrontHeroSlidesById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.putV1StorefrontHeroSlidesById, input, options),
    /** PUT /v1/storefront/hero-slides/order */
    putV1StorefrontHeroSlidesOrder: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.putV1StorefrontHeroSlidesOrder, undefined, options),
    /** PUT /v1/storefront/nav-items/:id */
    putV1StorefrontNavItemsById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.putV1StorefrontNavItemsById, input, options),
    /** PUT /v1/storefront/nav-items/layout */
    putV1StorefrontNavItemsLayout: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.putV1StorefrontNavItemsLayout, undefined, options),
    /** PUT /v1/storefront/payments */
    putV1StorefrontPayments: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.putV1StorefrontPayments, undefined, options),
    /** PUT /v1/storefront/products */
    putV1StorefrontProducts: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.putV1StorefrontProducts, undefined, options),
    /** PUT /v1/storefront/products/:id */
    putV1StorefrontProductsById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.putV1StorefrontProductsById, input, options),
    /** PUT /v1/storefront/size-charts/:id */
    putV1StorefrontSizeChartsById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.putV1StorefrontSizeChartsById, input, options),
    /** PUT /v1/storefront/tracking */
    putV1StorefrontTracking: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.putV1StorefrontTracking, undefined, options),
    /** PUT /v1/supply/sku-costs */
    putV1SupplySkuCosts: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.putV1SupplySkuCosts, undefined, options),
    /** PUT /v1/terminals/:id */
    putV1TerminalsById: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.putV1TerminalsById, input, options),
    /** PUT /v1/terminals/:id/cameras */
    putV1TerminalsByIdCameras: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.putV1TerminalsByIdCameras, input, options),
    /** PUT /v1/terminals/:id/members */
    putV1TerminalsByIdMembers: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.putV1TerminalsByIdMembers, input, options),
    /** The owner has read it: the unread count goes to zero. */
    readInboxConversation: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.readInboxConversation, input, options),
    /** Release a conversation back to Unassigned. */
    releaseInboxConversation: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.releaseInboxConversation, input, options),
    /** Put an order back in the unassigned queue (its owner or a supervisor). */
    releaseOrder: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.releaseOrder, input, options),
    /** Remove a product interest. */
    removeInboxInterest: (
      input: { readonly path: { readonly id: string; readonly interestId: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.removeInboxInterest, input, options),
    /** Reopen a closed conversation. */
    reopenInboxConversation: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.reopenInboxConversation, input, options),
    /** Ask to reopen a closed month. Needs an approval. */
    reopenPeriod: (
      input: { readonly body: ReopenPeriodInput },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.reopenPeriod, input, options),
    /** Reply. Refused outside the 24-hour window (INBOX_WINDOW_CLOSED); sent by a job after the commit. */
    replyInInboxConversation: (
      input: { readonly path: { readonly id: string }; readonly body: InboxReplyInput },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.replyInInboxConversation, input, options),
    /** The console reports whether its tab is visible and how long since the last input. */
    reportPresence: (
      input: { readonly body: PresenceBeat },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.reportPresence, input, options),
    /** Remove a person's second factor, so they enrol again at next sign-in. */
    resetUserTwoFactor: (
      input: { readonly path: { readonly id: string }; readonly body: CredentialResetInput },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.resetUserTwoFactor, input, options),
    /** Set a staff member's work types and hub location. */
    saveDeskProfile: (
      input: { readonly path: { readonly userId: string }; readonly body: DeskProfileInput },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.saveDeskProfile, input, options),
    /** Save a channel: its Meta id, on or off, and (write-only) its token. */
    saveInboxChannel: (
      input: { readonly path: { readonly kind: string }; readonly body: InboxChannelUpdateInput },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.saveInboxChannel, input, options),
    /** Save the contact's address: district, thana, area and line. */
    saveInboxContactAddress: (
      input: { readonly path: { readonly id: string }; readonly body: InboxAddressInput },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.saveInboxContactAddress, input, options),
    /** Save the contact's phone; links the brand's buyer with that number. */
    saveInboxContactPhone: (
      input: { readonly path: { readonly id: string }; readonly body: InboxPhoneInput },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.saveInboxContactPhone, input, options),
    /** Save the Meta app's secret and the webhook's verify token (write-only). */
    saveInboxMetaApp: (
      input: { readonly body: InboxMetaAppInput },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.saveInboxMetaApp, input, options),
    /** Change auto-assign, the offer countdown and the cap on open orders per person. */
    saveWorkflowSettings: (
      input: { readonly body: WorkflowSettingsInput },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.saveWorkflowSettings, input, options),
    /** The call log, its filters in the body so a phone stays out of URLs. */
    searchPhoneCalls: (
      input: { readonly body: unknown },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.searchPhoneCalls, input, options),
    /** Set this organization's maker-checker thresholds. */
    setApprovalThresholds: (
      input: { readonly body: ThresholdInput },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.setApprovalThresholds, input, options),
    /** Mark the contact a lead, not qualified or fraud, or hand the stage back to the rules. */
    setInboxContactStage: (
      input: { readonly path: { readonly id: string }; readonly body: InboxStageInput },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.setInboxContactStage, input, options),
    /** Replace the contact's tags. */
    setInboxContactTags: (
      input: { readonly path: { readonly id: string }; readonly body: InboxTagsInput },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.setInboxContactTags, input, options),
    /** Switch "Not taking orders" on or off for yourself. */
    setNotTakingOrders: (
      input: { readonly body: PresencePause },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.setNotTakingOrders, input, options),
    /** Choose which roles must use two-step sign-in in this brand (super admins only). */
    setTwoFactorPolicy: (
      input: { readonly body: TwoFactorPolicyInput },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.setTwoFactorPolicy, input, options),
    /** Replace a person's roles and branch scope in this organization. */
    setUserRoles: (
      input: { readonly path: { readonly id: string }; readonly body: SetRoles },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.setUserRoles, input, options),
    /** End a person's sessions: everywhere, or in this brand for someone in another. */
    signOutUserEverywhere: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.signOutUserEverywhere, input, options),
    /** With your password and a current code, start moving two-step sign-in to a new phone. */
    startTwoFactorReplacement: (
      input: { readonly body: ConfirmWithCode },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.startTwoFactorReplacement, input, options),
    /** Give up your own super admin power at once; never the last super admin. */
    stepDownSuperAdmin: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.stepDownSuperAdmin, undefined, options),
    /** Enter an organization for the rest of this session. */
    switchOrg: (input: { readonly body: SwitchOrg }, options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.switchOrg, input, options),
    /** Take a conversation; someone else's needs x-acknowledge-owner: 1. */
    takeInboxConversation: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.takeInboxConversation, input, options),
    /** Who is active, idle or away, their open orders, today's confirmations and offers. */
    teamBoard: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.teamBoard, undefined, options),
    /** Read the connection's extensions and numbers from Envo with its key. */
    testTelephonyConnection: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.testTelephonyConnection, input, options),
    /** Debit and credit totals per account as of a business date. */
    trialBalance: (
      input: { readonly query: { readonly asOf: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.trialBalance, input, options),
    /** With your password and a current code, turn two-step sign-in off where nothing requires it. */
    turnOffMyTwoFactor: (
      input: { readonly body: ConfirmWithCode },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.turnOffMyTwoFactor, input, options),
    /** Turn a person's two-step sign-in off, where no role of theirs requires it. */
    turnOffUserTwoFactor: (
      input: { readonly path: { readonly id: string }; readonly body: CredentialResetInput },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.turnOffUserTwoFactor, input, options),
    /** Change the name you go by. */
    updateMyProfile: (
      input: { readonly body: UpdateProfile },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.updateMyProfile, input, options),
    /** Change a packing camera, switch it off, or replace or remove its password. */
    updatePackingCamera: (
      input: { readonly path: { readonly id: string }; readonly body: PackingCameraUpdateInput },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.updatePackingCamera, input, options),
    /** Change a saved reply. */
    updateSavedReply: (
      input: { readonly path: { readonly id: string }; readonly body: SavedReplyInput },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.updateSavedReply, input, options),
    /** Change a connection; a secret left out is kept. */
    updateTelephonyConnection: (
      input: {
        readonly path: { readonly id: string };
        readonly body: TelephonyConnectionUpdateInput;
      },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.updateTelephonyConnection, input, options),
    /** Issue, ask for, or collect a one-time link that sets a password. */
    userPasswordLink: (
      input: { readonly path: { readonly id: string }; readonly body: CredentialResetInput },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.userPasswordLink, input, options),
    /** Say yes to making an admin a super admin: at once while there is one super admin, else when all have. */
    voteSuperAdmin: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.voteSuperAdmin, input, options),
    /** Say yes to removing a super admin: the first starts it; it removes when every other super admin has. */
    voteSuperAdminRemoval: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.voteSuperAdminRemoval, input, options),
    /** Vouch for an admin: two thirds of the independent admins make them trusted. */
    voteUserTrust: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.voteUserTrust, input, options),
    /** Withdraw a pending super admin nomination. */
    withdrawSuperAdminNomination: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> =>
      request(runtime, OPERATIONS.withdrawSuperAdminNomination, input, options),
    /** Withdraw a pending super admin removal. */
    withdrawSuperAdminRemoval: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.withdrawSuperAdminRemoval, input, options),
    /** Withdraw your trust vote for an admin. */
    withdrawUserTrust: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.withdrawUserTrust, input, options),
    /** Wrap up your own call once: its result, what it was about, a call-back; on a callable order also M41's attempt (a colleague's order needs x-acknowledge-owner: 1). */
    wrapUpPhoneCall: (
      input: { readonly path: { readonly id: string }; readonly body: PhoneCallWrapUpInput },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.wrapUpPhoneCall, input, options),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
