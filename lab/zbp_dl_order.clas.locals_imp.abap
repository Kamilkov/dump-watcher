CLASS lhc_laborder DEFINITION INHERITING FROM cl_abap_behavior_handler.
  PRIVATE SECTION.
    METHODS get_instance_authorizations FOR INSTANCE AUTHORIZATION
      IMPORTING keys REQUEST requested_authorizations FOR LabOrder RESULT result.
    METHODS recalculate FOR MODIFY
      IMPORTING keys FOR ACTION LabOrder~recalculate RESULT result.
ENDCLASS.


CLASS lhc_laborder IMPLEMENTATION.
  METHOD get_instance_authorizations.
    result = VALUE #( FOR key IN keys ( %tky = key-%tky %action-recalculate = if_abap_behv=>auth-allowed ) ).
  ENDMETHOD.

  METHOD recalculate.
    READ ENTITIES OF zi_dl_order IN LOCAL MODE
      ENTITY LabOrder FIELDS ( Quantity Currency ) WITH CORRESPONDING #( keys )
      RESULT DATA(orders).

    MODIFY ENTITIES OF zi_dl_order IN LOCAL MODE
      ENTITY LabOrder UPDATE FIELDS ( DiscountPct )
      WITH VALUE #( FOR order IN orders
                    ( %tky        = order-%tky
                      DiscountPct = zcl_dl_pricing=>discount_pct( quantity = order-Quantity
                                                                  currency = order-Currency ) ) ).

    READ ENTITIES OF zi_dl_order IN LOCAL MODE
      ENTITY LabOrder ALL FIELDS WITH CORRESPONDING #( keys )
      RESULT DATA(updated).
    result = VALUE #( FOR row IN updated ( %tky = row-%tky %param = row ) ).
  ENDMETHOD.
ENDCLASS.
