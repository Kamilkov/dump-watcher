@AccessControl.authorizationCheck: #CHECK
@EndUserText.label: 'Dump lab: order'
define root view entity ZI_DL_Order
  as select from zdl_order
{
  key order_id     as OrderId,
      customer     as Customer,
      product      as Product,
      quantity     as Quantity,
      currency     as Currency,
      discount_pct as DiscountPct
}
