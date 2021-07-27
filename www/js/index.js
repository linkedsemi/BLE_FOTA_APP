'use strict';
const fota_svc_uuid = "2600";
const fota_ctrl_char_uuid = "7000";
const fota_data_char_uuid = "7001";
const fota_ctrl_type = {
    SIGNATURE : 0,
    DIGEST : 1,
    START_REQ : 2,
    START_RSP : 3,
    NEW_SECTOR: 4,
    INTEGRITY_CHECK_REQ : 5,
    INTEGRITY_CHECK_RSP : 6,
};
const MTU_SIZE_TO_REQ = 517;
var app = {
    initialize: function() {
        this.bindEvents();
        detailPage.hidden = true;
    },
    bindEvents: function() {
        document.addEventListener('deviceready', this.onDeviceReady, false);
        selectImage.addEventListener('change', this.readImageFile,false);
        selectSignature.addEventListener('change',this.readSignatureFile,false);
        refreshButton.addEventListener('touchstart', this.refreshDeviceList, false);
        startFOTAButton.addEventListener('touchstart', this.startFOTA, false);
        disconnectButton.addEventListener('touchstart', this.disconnect, false);
        deviceList.addEventListener('touchstart', this.selectDev, false);
        connectButton.addEventListener('touchstart',this.connect,false);
    },
    selectDev: function(e){
        document.getElementById("selectedDevice").innerHTML = e.target.dataset.deviceId;
    },
    imageData : null,
    imageDigestData : null,
    signatureData : null,
    seg_data_length_max : 23 - 4,
    readImageFile: function(e) {
        let reader = new FileReader();
        reader.onload = function(e) {
            app.imageData = new Uint8Array(e.target.result);
            window.crypto.subtle.digest(
                {
                    name: "SHA-256",
                },
                app.imageData //The data you want to hash as an ArrayBuffer
            )
            .then(function(hash){
                //returns the hash as an ArrayBuffer
                app.imageDigestData = new Uint8Array(hash);
            })
            .catch(function(err){
                console.error(err);
            });
        };
        reader.readAsArrayBuffer(selectImage.files[0]);
    },
    readSignatureFile : function(e){
        let reader = new FileReader();
        reader.onload = function(e) {
            app.signatureData = new Uint8Array(e.target.result);
        };
        reader.readAsArrayBuffer(selectSignature.files[0]);
    },
    onDeviceReady: function() {
        console.log("on device ready");
    },
    refreshDeviceList: function() {
        deviceList.innerHTML = ''; // empties the list
        // scan for all devices
        ble.scan([], 5, app.onDiscoverDevice, app.onError);
    },
    onDiscoverDevice: function(device) {

        console.log(JSON.stringify(device));
        var listItem = document.createElement('li'),
            html = '<b>' + device.name + '</b><br/>' +
                'RSSI: ' + device.rssi + '&nbsp;|&nbsp;' +
                device.id;

        listItem.dataset.deviceId = device.id;
        listItem.innerHTML = html;
        deviceList.appendChild(listItem);

    },
    peer_info: null,
    connect: function(e) {
        var deviceId = document.getElementById("selectedDevice").innerHTML,
            onConnect = function(info) {
                console.log(info);
                app.peer_info = info;
                startFOTAButton.dataset.deviceId = deviceId;
                disconnectButton.dataset.deviceId = deviceId;
                app.showDetailPage();
                ble.requestMtu(deviceId,MTU_SIZE_TO_REQ,function(mtu){
                    console.log("mtu:"+mtu);
                    app.seg_data_length_max = mtu - 4;
                },function()
                {
                    console.warn("Failed to request MTU.");
                });
            };
        ble.stopScan();
        ble.connect(deviceId, onConnect, app.onError);
        console.log("connecting: " + deviceId);
    },
    startFOTA: function(event) {
        console.log("startFOTA");
        var deviceId = event.target.dataset.deviceId;
        ble.startNotification(deviceId, fota_svc_uuid, fota_ctrl_char_uuid, function(buffer){
            let data = new Uint8Array(buffer);
            switch(data[0])
            {
            case fota_ctrl_type.START_RSP:
                if(data[1] == 0)
                {
                    image_send();
                }
            break;
            case fota_ctrl_type.INTEGRITY_CHECK_RSP:
                console.log("integrity check status: " + data[1]);
                document.getElementById("ota_text").innerHTML = " OTA complete, status:" + data[1];
                ble.disconnect(deviceId);
            break;
            default:
                console.error("error indication type");
            break;
            }
        }, function(error){
            console.log(error);
        });
        function integrity_check_req_send()
        {
            let integrity_check_req = new Uint8Array(1);
            integrity_check_req[0] = fota_ctrl_type.INTEGRITY_CHECK_REQ;
            ble.write(deviceId,fota_svc_uuid,fota_ctrl_char_uuid,integrity_check_req.buffer);
        }
        function image_send()
        {
            const SECTOR_SIZE = 4096;
            const ack_buf_length = Math.ceil(Math.ceil(SECTOR_SIZE/app.seg_data_length_max)/8);
            let sector_idx = 0;
            let sector_max = Math.ceil(app.imageData.length/SECTOR_SIZE);
            function image_sector_send()
            {
                let sector_data;
                if(sector_idx == sector_max - 1)
                {
                    sector_data = app.imageData.slice(SECTOR_SIZE*sector_idx);
                    if(sector_data.length<SECTOR_SIZE)
                    {
                        let i= SECTOR_SIZE - 1;
                        while(i>=sector_data.length)
                        {
                            sector_data[i] = 0xff;
                            i -= 1;
                        }
                    }
                }else
                {
                    sector_data = app.imageData.slice(SECTOR_SIZE*sector_idx,SECTOR_SIZE*(sector_idx+1));
                }
                let seg_idx = 0;
                let ack = new Uint8Array(ack_buf_length);
                function new_sector_cmd_send()
                {
                    let new_sector_cmd = new Uint8Array(3);
                    new_sector_cmd[0] = fota_ctrl_type.NEW_SECTOR;
                    new_sector_cmd.set(new Uint8Array(new Uint16Array([sector_idx]).buffer),1);
                    ble.write(deviceId,fota_svc_uuid,fota_ctrl_char_uuid,new_sector_cmd.buffer,segment_data_send);
                }
                function segment_data_send()
                {
                    while(ack[seg_idx/8] & 1<<seg_idx%8)
                    {
                        seg_idx += 1;
                    }
                    if(seg_idx < Math.ceil(SECTOR_SIZE/app.seg_data_length_max))
                    {
                        let data_length;
                        if(seg_idx == Math.ceil(SECTOR_SIZE/app.seg_data_length_max) - 1 )
                        {
                            data_length = SECTOR_SIZE%app.seg_data_length_max ? SECTOR_SIZE%app.seg_data_length_max : app.seg_data_length_max;
                        }else
                        {
                            data_length = app.seg_data_length_max;
                        }
                        let data_att = new Uint8Array(data_length + 1);
                        data_att[0] = seg_idx;
                        if(data_length == app.seg_data_length_max)
                        {
                            data_att.set(sector_data.slice(app.seg_data_length_max*seg_idx,app.seg_data_length_max*(seg_idx + 1)),1);
                        }else{
                            data_att.set(sector_data.slice(app.seg_data_length_max*seg_idx),1);
                        }
                        ble.writeWithoutResponse(deviceId,fota_svc_uuid,fota_data_char_uuid,data_att.buffer,segment_data_send);
                        seg_idx += 1;
                    }else{
                        console.log("read ack req sector: " + sector_idx);
                        function ack_read_error(error)
                        {
                            console.error(error);
                        }
                        ble.read(deviceId,fota_svc_uuid,fota_data_char_uuid,ack_read,ack_read_error);
                    }
                }
                function ack_read(data)
                {
                    ack = new Uint8Array(data);
                    function ack_check()
                    {
                        return ack.every(function(element, index) {
                            if(index == ack_buf_length - 1)
                            {
                                if(Math.ceil(SECTOR_SIZE/app.seg_data_length_max)%8)
                                {
                                    return (1<<(Math.ceil(SECTOR_SIZE/app.seg_data_length_max)%8)) - 1 == element;
                                }
                            }
                            return index>=ack_buf_length ? true : element == 0xff;
                        });
                    }
                    let all_acked = ack_check();
                    console.log("max_sector: " + sector_max + " ,current sector: " + sector_idx + " , ack: " + ack,', all_acked: ' + all_acked);
                    if(all_acked)
                    {
                        sector_idx += 1;
                        document.getElementById("ota_text").innerHTML = "" +sector_idx/sector_max +"";
                        if(sector_idx == sector_max)
                        {
                            integrity_check_req_send();
                        }else
                        {
                            image_sector_send();
                        }
                    }else
                    {
                        segment_data_send();
                    }
                }
                new_sector_cmd_send();
            }
            image_sector_send();
        }
        
        let i = 0;
        function signature_send(){
            if(i <4)
            {
                let ctrl_cmd = new Uint8Array(18);
                ctrl_cmd[0] = fota_ctrl_type.SIGNATURE;
                ctrl_cmd[1] = i;
                ctrl_cmd.set(app.signatureData.slice(16*i,16*(i+1)),2);
                ble.write(deviceId,fota_svc_uuid,fota_ctrl_char_uuid,ctrl_cmd.buffer,signature_send);
                i += 1;
            }else
            {
                i = 0;
                digest_send();
            }
        }
        function digest_send(){
            if(i<2)
            {
                let ctrl_cmd = new Uint8Array(18);
                ctrl_cmd[0] = fota_ctrl_type.DIGEST;
                ctrl_cmd[1] = i;
                ctrl_cmd.set(app.imageDigestData.slice(16*i,16*(i+1)),2);
                ble.write(deviceId,fota_svc_uuid,fota_ctrl_char_uuid,ctrl_cmd.buffer,digest_send,function (error)
                {
                    console.error(error);
                });
                i += 1;
            }else
            {
                i = 0;
                start_req_send();
            }
        }
        function start_req_send(){
            let ctrl_cmd = new Uint8Array(13);
            ctrl_cmd[0] = fota_ctrl_type.START_REQ;
            let ota_addr = parseInt(document.getElementById("OTAAddr").value,16);
            ctrl_cmd.set(new Uint8Array(new Uint32Array([ota_addr,app.imageData.length,app.seg_data_length_max]).buffer),1);
            ble.write(deviceId,fota_svc_uuid,fota_ctrl_char_uuid,ctrl_cmd.buffer);
        }
        if(app.signatureData != null)
        {
            signature_send();
        }else{
            digest_send();
        }
    },
    disconnect: function(event) {
        var deviceId = event.target.dataset.deviceId;
        ble.disconnect(deviceId, app.showMainPage, app.onError);
    },
    showMainPage: function() {
        mainPage.hidden = false;
        detailPage.hidden = true;
    },
    showDetailPage: function() {
        mainPage.hidden = true;
        detailPage.hidden = false;
    },
    onError: function(reason) {
        alert("ERROR: " + reason); // real apps should use notification.alert
    }
};
