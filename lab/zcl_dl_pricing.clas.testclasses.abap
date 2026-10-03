CLASS ltc_pricing DEFINITION FINAL FOR TESTING DURATION SHORT RISK LEVEL HARMLESS.
  PRIVATE SECTION.
    CLASS-DATA sql TYPE REF TO if_osql_test_environment.
    CLASS-METHODS class_setup.
    CLASS-METHODS class_teardown.
    METHODS setup.
    METHODS medium_order_gets_5_percent FOR TESTING.
ENDCLASS.


CLASS ltc_pricing IMPLEMENTATION.
  METHOD class_setup.
    sql = cl_osql_test_environment=>create( i_dependency_list = VALUE #( ( 'ZDL_CONFIG' ) ) ).
  ENDMETHOD.

  METHOD class_teardown.
    sql->destroy( ).
  ENDMETHOD.

  METHOD setup.
    DATA config TYPE STANDARD TABLE OF zdl_config WITH EMPTY KEY.
    sql->clear_doubles( ).
    config = VALUE #( ( currency = 'EUR' description = 'Euro' ) ).
    sql->insert_test_data( config ).
  ENDMETHOD.

  METHOD medium_order_gets_5_percent.
    cl_abap_unit_assert=>assert_equals( act = zcl_dl_pricing=>discount_pct( quantity = 20 currency = 'EUR' )
                                        exp = 5 ).
  ENDMETHOD.
ENDCLASS.
