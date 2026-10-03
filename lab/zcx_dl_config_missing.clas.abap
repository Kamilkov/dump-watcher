CLASS zcx_dl_config_missing DEFINITION PUBLIC INHERITING FROM cx_no_check FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    DATA currency TYPE zdl_config-currency READ-ONLY.
    METHODS constructor
      IMPORTING previous LIKE previous OPTIONAL
                currency TYPE zdl_config-currency OPTIONAL.
    METHODS if_message~get_text REDEFINITION.
ENDCLASS.


CLASS zcx_dl_config_missing IMPLEMENTATION.
  METHOD constructor.
    super->constructor( previous = previous ).
    me->currency = currency.
  ENDMETHOD.

  METHOD if_message~get_text.
    result = |Currency { currency } has no entry in ZDL_CONFIG. Maintain it before pricing orders.|.
  ENDMETHOD.
ENDCLASS.
