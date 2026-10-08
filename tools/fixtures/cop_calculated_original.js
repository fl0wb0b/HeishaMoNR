var runtime =   global.get('compressor_runtime', "file");                                    // Get the global variable for absorbed energy of the heatpump



var TOP6_Main_Outlet_Temp=global.get('TOP6_Main_Outlet_Temp');                  // Get the global variable for water Outlet temperature
var TOP5_Main_Inlet_Temp=global.get('TOP5_Main_Inlet_Temp');                    // Get the global variable for water inlet temperature
var TOP1_Pump_Flow=global.get('TOP1_Pump_Flow');                                // Get the global variable for water flow
var Energy_Consumption;                                                         // declare variable
var TOP16_Heat_Energy_Consumption;                                              // declare variable
var COP_calculated;                                                             // declare variable
var Watt_heat_c;                                                                // declare variable
var TOP20_ThreeWay_Valve_State=global.get('TOP20_ThreeWay_Valve_State');        // Get the global variable for 3-way valve position.   0=HEAT / 1=DHW

// Check if all required temperatures are available. If not, exit this function.
if (TOP6_Main_Outlet_Temp === undefined || TOP5_Main_Inlet_Temp === undefined || TOP1_Pump_Flow === undefined) { return null; }


// *********** HEAT energy consumption calculation
if (TOP20_ThreeWay_Valve_State == 0){
        Energy_Consumption = global.get('TOP16_Heat_Energy_Consumption');             // Get the global variable for absorbed energy of the heatpump heat
        if (Energy_Consumption === undefined || isNaN(Energy_Consumption) === true) {
            TOP16_Heat_Energy_Consumption = 0;
            return null;
        }
}

// *********** DHW energy consumption calculation
if (TOP20_ThreeWay_Valve_State === 1){
        Energy_Consumption = global.get('TOP41_DHW_Energy_Consumption');       // Get the global variable for absorbed energy of the heatpump dhw
        if (Energy_Consumption === undefined || isNaN(Energy_Consumption) === true) {
            TOP16_Heat_Energy_Consumption = 0;
            return null;
        }
}

        
let msg1={}, msg2={}, msg3={}, msg10={}, msg20={};
msg3.payload = 0;

//msg3 is meant to send 0 for the dashboard linechart. Not to be sent to barchart.
if (TOP20_ThreeWay_Valve_State === 0 && Energy_Consumption !== 0)    // HEAT mode
{   msg3.topic = "COP_DHW"; 
    node.send([null, null, msg3]) 
}
if (TOP20_ThreeWay_Valve_State === 0 && Energy_Consumption === 0)    // HEAT mode
{   msg3.topic = "COP_HEAT"; 
    node.send([null, null, msg3])
    msg3.topic = "COP_DHW";
    node.send([null, null, msg3])
}
if (TOP20_ThreeWay_Valve_State === 1 && Energy_Consumption !== 0)    // DHW mode
{   msg3.topic = "COP_HEAT"; 
    node.send([null, null, msg3])
}
if (TOP20_ThreeWay_Valve_State === 1 && Energy_Consumption === 0)    // DHW mode
{   msg3.topic = "COP_DHW"; 
    node.send([null, null, msg3])
    msg3.topic = "COP_HEAT";
    node.send([null, null, msg3])
}


if (runtime === undefined || runtime < 2) {
    return null;
}

//**********************************************************************
if (TOP20_ThreeWay_Valve_State === 0 && Energy_Consumption !== 0){    //  HEAT mode

    Watt_heat_c             = (TOP6_Main_Outlet_Temp - TOP5_Main_Inlet_Temp) * 4.187 * (TOP1_Pump_Flow / 60) * 1000;
    
    COP_calculated          = Watt_heat_c / Energy_Consumption;
    msg1.payload            = COP_calculated
    msg1.topic              = "COP_HEAT";
    msg1.payload            = Number(msg1.payload).toFixed(2);
    msg1.payload            = parseFloat(msg1.payload);
    global.set('COP_HEAT', msg1.payload);

    // new: heat produced
    msg10.payload = Watt_heat_c / 1000;
    msg10.topic = "Prod_HEAT";
    msg10.payload = Number(msg10.payload).toFixed(2);
    msg10.payload = parseFloat(msg10.payload);
    msg20.payload = 0;
    msg20.topic = "Prod_DHW";
    // end of new


    if (msg1.payload > 0 || msg1.payload < 0) {
        return [msg1,null,null,msg10,msg20];
    }
    if (msg1.payload === undefined){
        return [null, null, null, null, null];
    }
    else {
        msg1.payload = 0;
        return [msg1, null, null, msg10, msg20];
    }
    
}

//**********************************************************************
if (TOP20_ThreeWay_Valve_State === 1 && Energy_Consumption !== 0)    // DHW mode
    {
        
        Watt_heat_c             = (TOP6_Main_Outlet_Temp - TOP5_Main_Inlet_Temp) * 4.187 * (TOP1_Pump_Flow / 60) * 1000;
        COP_calculated          = Watt_heat_c / Energy_Consumption;
        msg2.payload            = COP_calculated
        msg2.topic              = "COP_DHW";
        msg2.payload            = Number(msg2.payload).toFixed(2);
        msg2.payload            = parseFloat(msg2.payload);
        global.set('COP_DHW', msg2.payload );
    
        // new: heat produced
        msg10.topic = "Prod_HEAT";
        msg10.payload = 0;
        msg20.payload = Watt_heat_c / 1000;
        msg20.topic = "Prod_DHW";
        msg20.payload = Number(msg20.payload).toFixed(2);
        msg20.payload = parseFloat(msg20.payload);

        // end of new


        msg3.topic = "COP_HEAT";  // send 0 value to COP_HEAT when DHW is active.

        if (msg2.payload > 0) {
            return [null, msg2, null, msg10, msg20];
        }
        if (msg2.payload === undefined){
            return [null, null, null, null, null];
        }
        else    {
            msg2.payload = 0;
            return [null, msg2, null, msg10, msg20];
        }
}