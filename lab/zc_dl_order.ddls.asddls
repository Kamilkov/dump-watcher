@AccessControl.authorizationCheck: #CHECK
@EndUserText.label: 'Dump lab: order'
@UI.headerInfo: { typeName: 'Order', typeNamePlural: 'Orders', title: { value: 'OrderId' } }
define root view entity ZC_DL_Order
  provider contract transactional_query
  as projection on ZI_DL_Order
{
      @UI.facet: [{ id: 'Order', purpose: #STANDARD, type: #IDENTIFICATION_REFERENCE, label: 'Order', position: 10 }]
      @UI.lineItem: [{ position: 10 }, { type: #FOR_ACTION, dataAction: 'recalculate', label: 'Recalculate' }]
      @UI.identification: [{ position: 10 }, { type: #FOR_ACTION, dataAction: 'recalculate', label: 'Recalculate' }]
  key OrderId,
      @UI.lineItem: [{ position: 20 }]
      @UI.identification: [{ position: 20 }]
      @UI.selectionField: [{ position: 10 }]
      @Consumption.valueHelpDefinition: [{ entity: { name: 'ZC_DL_Order', element: 'Customer' } }]
      Customer,
      @UI.lineItem: [{ position: 30 }]
      @UI.identification: [{ position: 30 }]
      Product,
      @UI.lineItem: [{ position: 40 }]
      @UI.identification: [{ position: 40 }]
      Quantity,
      @UI.lineItem: [{ position: 50 }]
      @UI.identification: [{ position: 50 }]
      Currency,
      @UI.lineItem: [{ position: 60 }]
      @UI.identification: [{ position: 60 }]
      DiscountPct
}
