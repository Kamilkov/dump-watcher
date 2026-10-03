@AccessControl.authorizationCheck: #CHECK
@EndUserText.label: 'Dump lab: customer value help'
define view entity ZC_DL_CustomerVH
  as select distinct from zdl_order
{
  key customer as Customer
}
