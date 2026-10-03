CLASS zcl_dl_pricing DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    TYPES: BEGIN OF ty_tier,
             min_quantity TYPE i,
             discount_pct TYPE i,
           END OF ty_tier,
           ty_tiers TYPE STANDARD TABLE OF ty_tier WITH EMPTY KEY.

    "! Volume discount in percent for an order.
    CLASS-METHODS discount_pct
      IMPORTING quantity      TYPE i
                currency      TYPE zdl_config-currency
      RETURNING VALUE(result) TYPE i.
  PROTECTED SECTION.
  PRIVATE SECTION.
ENDCLASS.


CLASS zcl_dl_pricing IMPLEMENTATION.
  METHOD discount_pct.
    " Every currency needs an entry in ZDL_CONFIG; a missing one is a setup error, not a code path.
    SELECT SINGLE @abap_true FROM zdl_config WHERE currency = @currency INTO @DATA(configured).
    IF configured <> abap_true.
      RAISE SHORTDUMP TYPE zcx_dl_config_missing EXPORTING currency = currency.
    ENDIF.

    DATA(tiers) = VALUE ty_tiers( ( min_quantity = 10  discount_pct = 5 )
                                  ( min_quantity = 50  discount_pct = 10 )
                                  ( min_quantity = 100 discount_pct = 15 ) ).
    FIELD-SYMBOLS <tier> TYPE ty_tier.
    LOOP AT tiers ASSIGNING <tier> WHERE min_quantity <= quantity.
    ENDLOOP.
    result = <tier>-discount_pct.
  ENDMETHOD.
ENDCLASS.
