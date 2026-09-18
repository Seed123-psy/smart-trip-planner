/**
 * 自动生成，请勿手改 —— 由 tools/generate-routes.js 产出
 * 生成时间：2026-09-17T01:16:36.093Z
 * 修改行程后请重新运行：node tools/generate-routes.js
 */
window.TRIP_ROUTES = {
  "generatedAt": "2026-09-17T01:16:36.093Z",
  "summary": {
    "days": 4,
    "legs": 26,
    "pendingLocations": []
  },
  "locations": {
    "airport-t3": {
      "coords": [
        114.213098,
        30.768786
      ],
      "formattedAddress": "武汉天河国际机场T3航站楼"
    },
    "hotel": {
      "coords": [
        114.196077,
        30.535053
      ],
      "formattedAddress": "中交五洲皇冠酒店"
    },
    "shanhaiguan-road": {
      "coords": [
        114.310208,
        30.602394
      ],
      "formattedAddress": "山海关路"
    },
    "lihuangpi-road": {
      "coords": [
        114.299353,
        30.587731
      ],
      "formattedAddress": "黎黄陂路"
    },
    "bagong-fangzi": {
      "coords": [
        114.299831,
        30.586141
      ],
      "formattedAddress": "巴公房子"
    },
    "xianfang": {
      "coords": [
        114.293535,
        30.584931
      ],
      "formattedAddress": "咸安坊（顺路）"
    },
    "jianghan-road": {
      "coords": [
        114.290521,
        30.581672
      ],
      "formattedAddress": "江汉路步行街"
    },
    "hankou-beach": {
      "coords": [
        114.314625,
        30.607245
      ],
      "formattedAddress": "汉口江滩"
    },
    "hubei-museum": {
      "coords": [
        114.365261,
        30.561633
      ],
      "formattedAddress": "湖北省博物馆"
    },
    "donghu-tingtao": {
      "coords": [
        114.376688,
        30.564713
      ],
      "formattedAddress": "东湖听涛景区"
    },
    "wuhan-university": {
      "coords": [
        114.364514,
        30.536243
      ],
      "formattedAddress": "武汉大学"
    },
    "lingbomen": {
      "coords": [
        114.363807,
        30.545119
      ],
      "formattedAddress": "凌波门"
    },
    "chuhe-hanjie": {
      "coords": [
        114.340331,
        30.554925
      ],
      "formattedAddress": "楚河汉街"
    },
    "tanhualin": {
      "coords": [
        114.308791,
        30.55194
      ],
      "formattedAddress": "昙华林"
    },
    "liangdao-street": {
      "coords": [
        114.310451,
        30.547408
      ],
      "formattedAddress": "粮道街"
    },
    "huanghelou": {
      "coords": [
        114.305298,
        30.543475
      ],
      "formattedAddress": "黄鹤楼"
    },
    "hongqiang": {
      "coords": [
        114.302691,
        30.547544
      ],
      "formattedAddress": "黄鹤楼红墙"
    },
    "yangtze-bridge": {
      "coords": [
        114.292874,
        30.547225
      ],
      "formattedAddress": "武汉长江大桥"
    },
    "zhonghualu-matou": {
      "coords": [
        114.294686,
        30.550602
      ],
      "formattedAddress": "中华路码头"
    },
    "wuhanguan-matou": {
      "coords": [
        114.29818,
        30.575127
      ],
      "formattedAddress": "武汉关码头"
    },
    "guiyuan-temple": {
      "coords": [
        114.260079,
        30.545484
      ],
      "formattedAddress": "归元禅寺"
    },
    "hanyangzao": {
      "coords": [
        114.268285,
        30.556247
      ],
      "formattedAddress": "汉阳造创意园"
    },
    "yuehu-park": {
      "coords": [
        114.260166,
        30.557715
      ],
      "formattedAddress": "月湖公园"
    },
    "hankouli": {
      "coords": [
        114.225873,
        30.618327
      ],
      "formattedAddress": "汉口里"
    }
  },
  "legs": [
    {
      "id": "day1-leg1",
      "dayId": "day1",
      "fromIndex": 0,
      "toIndex": 1,
      "from": "airport-t3",
      "to": "hotel",
      "primary": "driving",
      "straightLineKm": 26.04,
      "modes": {
        "driving": {
          "distance": 34181,
          "duration": 3074
        },
        "transit": {
          "distance": 38614,
          "duration": 5972
        },
        "walking": {
          "distance": 39522,
          "duration": 31618
        }
      }
    },
    {
      "id": "day1-leg2",
      "dayId": "day1",
      "fromIndex": 1,
      "toIndex": 2,
      "from": "hotel",
      "to": "shanhaiguan-road",
      "primary": "driving",
      "straightLineKm": 13.25,
      "modes": {
        "driving": {
          "distance": 19080,
          "duration": 2808
        },
        "transit": {
          "distance": 17233,
          "duration": 3765
        },
        "walking": {
          "distance": 15853,
          "duration": 12682
        }
      }
    },
    {
      "id": "day1-leg3",
      "dayId": "day1",
      "fromIndex": 2,
      "toIndex": 3,
      "from": "shanhaiguan-road",
      "to": "lihuangpi-road",
      "primary": "driving",
      "straightLineKm": 1.93,
      "modes": {
        "driving": {
          "distance": 2285,
          "duration": 601
        },
        "transit": {
          "distance": 2547,
          "duration": 1359
        },
        "walking": {
          "distance": 2071,
          "duration": 1657
        }
      }
    },
    {
      "id": "day1-leg4",
      "dayId": "day1",
      "fromIndex": 3,
      "toIndex": 4,
      "from": "lihuangpi-road",
      "to": "bagong-fangzi",
      "primary": "walking",
      "straightLineKm": 0.18,
      "modes": {
        "walking": {
          "distance": 254,
          "duration": 203
        },
        "driving": {
          "distance": 382,
          "duration": 163
        },
        "transit": {
          "distance": 183,
          "duration": 30,
          "estimated": true
        }
      }
    },
    {
      "id": "day1-leg5",
      "dayId": "day1",
      "fromIndex": 4,
      "toIndex": 5,
      "from": "bagong-fangzi",
      "to": "jianghan-road",
      "primary": "walking",
      "straightLineKm": 1.02,
      "modes": {
        "walking": {
          "distance": 1365,
          "duration": 1092
        },
        "driving": {
          "distance": 2425,
          "duration": 978
        },
        "transit": {
          "distance": 1470,
          "duration": 1258
        }
      }
    },
    {
      "id": "day1-leg6",
      "dayId": "day1",
      "fromIndex": 5,
      "toIndex": 6,
      "from": "jianghan-road",
      "to": "hankou-beach",
      "primary": "walking",
      "straightLineKm": 3.66,
      "modes": {
        "walking": {
          "distance": 3948,
          "duration": 3158
        },
        "driving": {
          "distance": 4958,
          "duration": 918
        },
        "transit": {
          "distance": 4825,
          "duration": 2135
        }
      }
    },
    {
      "id": "day1-leg7",
      "dayId": "day1",
      "fromIndex": 6,
      "toIndex": 7,
      "from": "hankou-beach",
      "to": "hotel",
      "primary": "driving",
      "straightLineKm": 13.9,
      "modes": {
        "driving": {
          "distance": 17081,
          "duration": 2295
        },
        "transit": {
          "distance": 17060,
          "duration": 3558
        },
        "walking": {
          "distance": 16613,
          "duration": 13290
        }
      }
    },
    {
      "id": "day2-leg1",
      "dayId": "day2",
      "fromIndex": 0,
      "toIndex": 1,
      "from": "hotel",
      "to": "hubei-museum",
      "primary": "driving",
      "straightLineKm": 16.47,
      "modes": {
        "driving": {
          "distance": 25291,
          "duration": 2742
        },
        "transit": {
          "distance": 26925,
          "duration": 4385
        },
        "walking": {
          "distance": 20470,
          "duration": 16376
        }
      }
    },
    {
      "id": "day2-leg2",
      "dayId": "day2",
      "fromIndex": 1,
      "toIndex": 2,
      "from": "hubei-museum",
      "to": "donghu-tingtao",
      "primary": "walking",
      "straightLineKm": 1.15,
      "modes": {
        "walking": {
          "distance": 1495,
          "duration": 1196
        },
        "driving": {
          "distance": 1794,
          "duration": 687
        },
        "transit": {
          "distance": 3857,
          "duration": 1811
        }
      }
    },
    {
      "id": "day2-leg3",
      "dayId": "day2",
      "fromIndex": 2,
      "toIndex": 3,
      "from": "donghu-tingtao",
      "to": "wuhan-university",
      "primary": "driving",
      "straightLineKm": 3.37,
      "modes": {
        "driving": {
          "distance": 7648,
          "duration": 1430
        },
        "transit": {
          "distance": 8362,
          "duration": 4076
        },
        "walking": {
          "distance": 5832,
          "duration": 4666
        }
      }
    },
    {
      "id": "day2-leg4",
      "dayId": "day2",
      "fromIndex": 3,
      "toIndex": 4,
      "from": "wuhan-university",
      "to": "lingbomen",
      "primary": "walking",
      "straightLineKm": 0.99,
      "modes": {
        "walking": {
          "distance": 1697,
          "duration": 1358
        },
        "driving": {
          "distance": 2543,
          "duration": 513
        },
        "transit": {
          "distance": 3746,
          "duration": 1934
        }
      }
    },
    {
      "id": "day2-leg5",
      "dayId": "day2",
      "fromIndex": 4,
      "toIndex": 5,
      "from": "lingbomen",
      "to": "chuhe-hanjie",
      "primary": "driving",
      "straightLineKm": 2.5,
      "modes": {
        "driving": {
          "distance": 3188,
          "duration": 650
        },
        "transit": {
          "distance": 3563,
          "duration": 1926
        },
        "walking": {
          "distance": 2976,
          "duration": 2381
        }
      }
    },
    {
      "id": "day2-leg6",
      "dayId": "day2",
      "fromIndex": 5,
      "toIndex": 6,
      "from": "chuhe-hanjie",
      "to": "hotel",
      "primary": "driving",
      "straightLineKm": 13.99,
      "modes": {
        "driving": {
          "distance": 20829,
          "duration": 2219
        },
        "transit": {
          "distance": 19546,
          "duration": 3405
        },
        "walking": {
          "distance": 17383,
          "duration": 13906
        }
      }
    },
    {
      "id": "day3-leg1",
      "dayId": "day3",
      "fromIndex": 0,
      "toIndex": 1,
      "from": "hotel",
      "to": "tanhualin",
      "primary": "driving",
      "straightLineKm": 10.96,
      "modes": {
        "driving": {
          "distance": 19111,
          "duration": 2614
        },
        "transit": {
          "distance": 16464,
          "duration": 3499
        },
        "walking": {
          "distance": 14152,
          "duration": 11322
        }
      }
    },
    {
      "id": "day3-leg2",
      "dayId": "day3",
      "fromIndex": 1,
      "toIndex": 2,
      "from": "tanhualin",
      "to": "liangdao-street",
      "primary": "walking",
      "straightLineKm": 0.53,
      "modes": {
        "walking": {
          "distance": 674,
          "duration": 539
        },
        "driving": {
          "distance": 720,
          "duration": 296
        },
        "transit": {
          "distance": 528,
          "duration": 86,
          "estimated": true
        }
      }
    },
    {
      "id": "day3-leg3",
      "dayId": "day3",
      "fromIndex": 2,
      "toIndex": 3,
      "from": "liangdao-street",
      "to": "huanghelou",
      "primary": "walking",
      "straightLineKm": 0.66,
      "modes": {
        "walking": {
          "distance": 1171,
          "duration": 937
        },
        "driving": {
          "distance": 2436,
          "duration": 506
        },
        "transit": {
          "distance": 1449,
          "duration": 1690
        }
      }
    },
    {
      "id": "day3-leg4",
      "dayId": "day3",
      "fromIndex": 3,
      "toIndex": 4,
      "from": "huanghelou",
      "to": "hongqiang",
      "primary": "walking",
      "straightLineKm": 0.52,
      "modes": {
        "walking": {
          "distance": 1412,
          "duration": 1130
        },
        "driving": {
          "distance": 2613,
          "duration": 704
        },
        "transit": {
          "distance": 1669,
          "duration": 1472
        }
      }
    },
    {
      "id": "day3-leg5",
      "dayId": "day3",
      "fromIndex": 4,
      "toIndex": 5,
      "from": "hongqiang",
      "to": "yangtze-bridge",
      "primary": "walking",
      "straightLineKm": 0.94,
      "modes": {
        "walking": {
          "distance": 1210,
          "duration": 968
        },
        "driving": {
          "distance": 2869,
          "duration": 513
        },
        "transit": {
          "distance": 941,
          "duration": 154,
          "estimated": true
        }
      }
    },
    {
      "id": "day3-leg6",
      "dayId": "day3",
      "fromIndex": 5,
      "toIndex": 6,
      "from": "yangtze-bridge",
      "to": "zhonghualu-matou",
      "primary": "walking",
      "straightLineKm": 0.41,
      "modes": {
        "walking": {
          "distance": 1687,
          "duration": 1350
        },
        "driving": {
          "distance": 10168,
          "duration": 1594
        },
        "transit": {
          "distance": 2447,
          "duration": 1937
        }
      }
    },
    {
      "id": "day3-leg7",
      "dayId": "day3",
      "fromIndex": 6,
      "toIndex": 7,
      "from": "zhonghualu-matou",
      "to": "wuhanguan-matou",
      "primary": "transit",
      "straightLineKm": 2.75,
      "modes": {
        "transit": {
          "distance": 2999,
          "duration": 1857
        },
        "driving": {
          "distance": 12518,
          "duration": 1731
        },
        "walking": {
          "distance": 2987,
          "duration": 2390
        }
      }
    },
    {
      "id": "day3-leg8",
      "dayId": "day3",
      "fromIndex": 7,
      "toIndex": 8,
      "from": "wuhanguan-matou",
      "to": "hotel",
      "primary": "driving",
      "straightLineKm": 10.74,
      "modes": {
        "driving": {
          "distance": 16135,
          "duration": 2071
        },
        "transit": {
          "distance": 18174,
          "duration": 3926
        },
        "walking": {
          "distance": 13367,
          "duration": 10694
        }
      }
    },
    {
      "id": "day4-leg1",
      "dayId": "day4",
      "fromIndex": 0,
      "toIndex": 1,
      "from": "hotel",
      "to": "guiyuan-temple",
      "primary": "driving",
      "straightLineKm": 6.24,
      "modes": {
        "driving": {
          "distance": 10275,
          "duration": 1375
        },
        "transit": {
          "distance": 10698,
          "duration": 3055
        },
        "walking": {
          "distance": 8831,
          "duration": 7065
        }
      }
    },
    {
      "id": "day4-leg2",
      "dayId": "day4",
      "fromIndex": 1,
      "toIndex": 2,
      "from": "guiyuan-temple",
      "to": "hanyangzao",
      "primary": "driving",
      "straightLineKm": 1.43,
      "modes": {
        "driving": {
          "distance": 2321,
          "duration": 755
        },
        "transit": {
          "distance": 2607,
          "duration": 2121
        },
        "walking": {
          "distance": 2047,
          "duration": 1638
        }
      }
    },
    {
      "id": "day4-leg3",
      "dayId": "day4",
      "fromIndex": 2,
      "toIndex": 3,
      "from": "hanyangzao",
      "to": "yuehu-park",
      "primary": "walking",
      "straightLineKm": 0.79,
      "modes": {
        "walking": {
          "distance": 1282,
          "duration": 1026
        },
        "driving": {
          "distance": 6631,
          "duration": 1318
        },
        "transit": {
          "distance": 2277,
          "duration": 1481
        }
      }
    },
    {
      "id": "day4-leg4",
      "dayId": "day4",
      "fromIndex": 3,
      "toIndex": 4,
      "from": "yuehu-park",
      "to": "hotel",
      "primary": "driving",
      "straightLineKm": 6.63,
      "modes": {
        "driving": {
          "distance": 10493,
          "duration": 1247
        },
        "transit": {
          "distance": 11153,
          "duration": 3154
        },
        "walking": {
          "distance": 8838,
          "duration": 7070
        }
      }
    },
    {
      "id": "day4-leg5",
      "dayId": "day4",
      "fromIndex": 4,
      "toIndex": 5,
      "from": "hotel",
      "to": "airport-t3",
      "primary": "driving",
      "straightLineKm": 26.04,
      "modes": {
        "driving": {
          "distance": 33872,
          "duration": 3070
        },
        "transit": {
          "distance": 38665,
          "duration": 6098
        },
        "walking": {
          "distance": 39560,
          "duration": 31648
        }
      }
    }
  ]
};
